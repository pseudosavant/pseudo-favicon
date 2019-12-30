'use strict';

const express = require('express');
const app = express();

const Url = require('url');
const https = require('https');
const http = require('http');
//const fetch = require('fetch-h2').fetch;
const fetch = require('node-fetch');
const x = require('x-ray')();
const crypto = require('crypto');
const fs = require('fs')

const tls = require('tls');
tls.DEFAULT_MIN_VERSION = 'TLSv1';

var rootCas = require('ssl-root-cas/latest').create();
https.globalAgent.options.ca = rootCas;
https.globalAgent.options.rejectUnauthorized = false; // Normally dangeous

const listener = app.listen(process.env.PORT, function() {
  console.info('Your app is listening on port ' + listener.address().port);
});

const oneYear = 365 * 24 * 60 * 60;
const thirtyMinutes = 30 * 60;

const config = {
  sourceCache: '/app/sourceCache/',
  pngCache: '/app/pngCache/',
  tempPath: '/app/temp/',
  cacheDuration: 60,
  caching: false
}

//app.use(express.static('public'));

app.get('/', async function(req, res) {
  try {
    const url = decodeURIComponent(req.query.url);

    // TODO: More signficant URL validation
    if (!url) {
      res.send('Please supply a URI encoded url as a URL query parameter');
      return;
    }
    
    if (config.caching) {
      const cachedIcon = await getCachedIcon(url);
      if (cachedIcon) {
        console.info(`${url} early cache hit`);
        await sendIcon(cachedIcon, res);
        return;
      } else {
        console.info(`${url} early cache miss`);
      }
    }

    console.info(`Checking ${url} for icons`);
    var icons = await getIcons(url);

    if (!hasEntries(icons.icons)) {
      const rootHostname = rootDomain(icons.url);
      console.info(`Checking ${rootHostname} for root icons`);
      icons = await getIcons(rootHostname);
    }

    if (!hasEntries(icons.icons)) throw { externalMsg: 'No icon URL found'};
    const bestIconUrl = pickBestIcon(icons);

    if (bestIconUrl) {
      const icon = await cachedFetchIcon(bestIconUrl, url);
      sendIcon(icon, res);
    } else {
      throw { externalMsg: 'No icon URL found'};
    }    
  } catch (e) {
    console.error(e);
    const msg = (e.externalMsg ? e.externalMsg : 'No icon URL found');
    res.status(404).send(msg);
  }
});

function sendIcon(icon, res) {
  res.status(200);
  res.set('Content-Disposition', 'inline');
  res.set('Content-Type', icon.type);
  res.set('Content-Length', icon.length);
  res.set('Cache-Control',`max-age=${config.cacheDuration}`);
  res.set('Access-Control-Allow-Origin', '*');
  res.set('x-icon-from-cache', icon.isCached);
  res.send(icon.buffer);
  // TODO: Etag and Last-Modified return 304 (Not Modified);
}

async function getIcons(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  
  const page = await getPageContents(url);

  const pageIcons = (page.ok ? await getPageIcons(page.html, page.url) : null);
  const rootIcon = await rootFaviconCheck(page.url);

  const icons = {
    ...pageIcons,
    ...(rootIcon ? { rootIcon: rootIcon } : null)
  };
  if (isEmptyObject(icons)) return { icons: null, url: page.url};
  
  const resolved = { icons: resolveUrls(icons, page.url), url: page.url };
  return resolved;
}

async function getPageIcons(html, baseUrl) {
  // TODO: Make all rel and name attributes lower case
  html = html.replace(/shortcut icon/gi, 'shortcut icon'); // Handle all caps

  const selectors = {
    shortcutIcon: 'link[rel="shortcut icon"]@href',
    icon: 'link[rel="icon"]@href',
    appleTouchIcon: 'link[rel="apple-touch-icon"]@href',
    appleTouchIconPrecomposed: 'link[rel="apple-touch-icon-precomposed"]@href',
    msapplicationTileImage: 'meta[name="msapplication-TileImage"]@content',
    twitter: 'meta[name="twitter:image"]@content',
    opengraph: 'meta[property="og:image"]@content',
    iconImage: 'img[src*="Icon"]@src'
  };
  const iconsArr = await x(html, 'html', [selectors]);
  const icons = (iconsArr && iconsArr[0] ? iconsArr[0] : null);

  // Do aggressive search of whole DOM looking for images that have 'logo' or 'icon' in the
  // filename. Also try to prioritize square icons
  
  // calculate image dimensions  
  if (icons && Object.keys(icons).length === 0) return null;
  return icons;
}

async function redirectCheck(url) {
  const page = await getPageContents(url);

  const frame = (page.ok ? await x(page.html, 'html', { src: 'frame@src'}) : null);
  const resolved = resolveUrl(frame.src, page.url);
  return resolved;
}

function isImageMimeType(res) {
  const type = (res && res.headers ? res.headers.get('Content-Type') : res);
  
  const imageRe = /image\//i;
  return imageRe.test(type);
}

async function rootFaviconCheck(url) {
  const opts = {
    method: 'HEAD'
  };
  
  const parsedUrl = Url.parse(url);
  
  const rootUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}/favicon.ico`;
  const res = await get(rootUrl, opts);

  // TODO: add check for if it is actuall an icon/png/jpg file
  if (res && res.ok && isImageMimeType(res)) {
    return rootUrl;
  }
  
  return null;
}

function rootDomain(url) {
  const parsedUrl = Url.parse(url);
  const hostname = parsedUrl.hostname;
  const protocol = parsedUrl.protocol;

  const domainRe = /\.([^.\s]+?\.[^.\s]+?)$/i;
  const result = domainRe.exec(hostname);
  const rootHostname = (result && result[1] ? result[1] : null);
  const rootDomain = (rootHostname ? `${protocol}//${rootHostname}` : null);

  return rootDomain;
}

function resolveUrls(urls, base) {
  Object.keys(urls).forEach(function(key){
    const url = urls[key];
    urls[key] = resolveUrl(base, url);
  });
  return urls;
}

function resolveUrl(base, url) {
  if (!url || !base) return url;
  return Url.resolve(base, url);
}

function pickBestIcon(iconsRes) {
  const icons = iconsRes.icons;
  const order = [
    'shortcutIcon',
    'rootIcon',
    'appleTouchIcon',
    'appleTouchIconPrecomposed',
    'opengraph',
    'twitter',
    'msapplicationTileImage',
    'rootDomainIcon',
    'iconImage'
  ];

  try {
    order.forEach(function(key){
      if (icons[key]) throw {icon: icons[key]};
    });
    
    throw { icon: false };
  } catch (e) {
    if (e.icon) return e.icon;
  }

  throw { externalMsg: `Unabled to select 'best' icon`, res: iconsRes};
}

async function fetchIcon(url) {
  const res = await get(url);
  
  if (res.ok && isImageMimeType(res)) {
    return {
      headers: [...res.headers.entries()],
      type: res.headers.get('Content-Type'),
      length: res.headers.get('Content-Length'),
      buffer: await res.buffer(),
      sourceUrl: url
    };
  }
  
  throw { externalMsg: `Unable to retrieve icon at ${url}`};
}

async function getCachedIcon(requestUrl) {
  const promise = new Promise(async function(resolve, reject){
    const hash = md5(requestUrl);
    
    const isCached = await iconExists(hash);
    var icon;
    if (config.caching && isCached) {
      icon = await readIcon(hash);
      icon.isCached = true;
    }
    
    if (icon) {
      resolve(icon);
    } else {
      resolve(null);
    }
  });
  
  return promise;
}

async function cachedFetchIcon(url, requestUrl) {
  const promise = new Promise(async function(resolve, reject){
    const hash = md5(requestUrl);
    
    const isCached = await iconExists(hash);
    var icon;

    if (config.caching && isCached) {
      console.info(`${url} cache hit`);
      icon = await readIcon(hash);
      icon.isCached = true;
    } else {
      console.info(`${url} cache miss`);

      if (isDataUri(url)) {
        icon = dataUriToIcon(url);
      } else {
        icon = await fetchIcon(url);
      }

      icon.isCached = false;
      writeIcon(hash, icon);
    }
    
    if (icon) resolve(icon);
  });
  
  return promise;
}

function readIcon(hash) {
  const promise = new Promise(function(resolve, reject){
    fs.readFile(getIconPath(hash), function(err, file){
      if (err) {
        console.error(err);
        throw { externalMsg: 'Unable to read file from cache'};
      }
      
      const icon = JSON.parse(file);
      icon.buffer = Buffer.from(icon.base64, 'base64');
      delete icon.base64;      

      console.info(`Read icon ${getIconPath(hash)} for ${icon.sourceUrl}`);
      
      resolve(icon);
    });
  });
  
  return promise;
}

function dataUriToIcon(uri) {
  const dataUriRe = /data:(image\/(?:png|jpeg));base64,(.*)==/i;
  const extracted = dataUriRe.exec(uri);
  const type = extracted[1];
  const base64 = extracted[2];
  const decoded = Buffer.from(base64, 'base64').toString('utf-8');  

  const icon = {
    headers: [],
    type: type,
    length: decoded.length,
    buffer: Buffer.from(base64, 'base64'),
    sourceUrl: 'dataUri'
  };

  return icon;
}

function iconBase64ToBuffer(icon) {
  try {
    icon.buffer = Buffer.from(icon.base64, 'base64');
    delete icon.base64;      
    return icon
  } catch (e) {
    console.error(e);
    throw { externalMsg: 'Unable to convert base64 to buffer' }
  }
}

function writeIcon(hash, icon) {
  const data = {
    headers: icon.headers,
    type: icon.type,
    length: icon.length,
    base64: icon.buffer.toString('base64'),
    sourceUrl: icon.sourceUrl
  };
  
  const json = JSON.stringify(data);
  
  const promise = new Promise(function(resolve, reject) {
    fs.writeFile(getIconPath(hash), json, 'utf8', (err) => {
      if (err) {
        console.error(err);
      } else {
        console.info(`Wrote icon ${getIconPath(hash)} for ${icon.sourceUrl}`);
      }
    });
  });
}

function getIconPath(hash) {
  return config.sourceCache + hash + '.json';
}

async function iconExists(hash) {
  const exists = await fileExists(getIconPath(hash));
  return exists;
}

function fileExists(path) {
  const promise = new Promise(function(resolve, reject ){
    try {
      fs.access(path, fs.constants.F_OK, (err) => {
        const exists = !err;
        console.info(`File ${path} ${(exists ? 'exists' : 'does not exist')}`);
        resolve(exists);
      });
    } catch(e) {
      console.error(`Error checking if ${path} exists`);
      console.error(e);
      resolve(false);
    }
  });
  
  return promise;
}

async function get(url, fetchOpts) {
  const httpsRe = /^https:\/\//i;
  const isHttps = httpsRe.test(url);
    
  const opts = fetchOpts || { redirect: 'follow' };
  
  try {
    const res = await fetch(url, opts);
    
    return res;
  } catch (e) {
    console.error(`Unable to fetch ${url}`);
    console.error(e);
    return null;
  }
}

async function getPageContents(url, opts) {
  try {    
    const res = await get(url, opts);

    if (!res.ok) return res;

    if (isValidHTMLResponse(res)) {
      const html = await res.text();
      return { ok: true, url: res.url, html: html};
    } else {
      throw { res, externalMsge: `${url} does not contain HTML` };
    }
  } catch(e) {
    console.error(e);
    return e.res;
  }  
}

function isValidHTMLResponse(res) {
  const isHtml = res && res.headers.get('Content-Type').match(/^text\/html/i);
  return isHtml;
}

function md5(s) {
  return (s ? crypto.createHash('md5').update(s).digest('hex') : null);
}

function isDataUri(uri) {
  const dataUriRe = /data:(image\/(?:png|jpeg));base64,(.*)==/i;  
  return dataUriRe.test(uri);
}

function isEmptyObject(o) {
  return Object.keys(o).length === 0;
}

function hasEntries(o) {
  return (o !== null && typeof o === 'object' ? Object.entries(o).length > 0 : false);
}

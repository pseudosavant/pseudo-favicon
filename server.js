'use strict';

const express = require('express');
const app = express();

const h2 = require('fetch-h2')
const fetch = h2.fetch;
const x = require('x-ray')();
const Url = require('url');
const crypto = require('crypto');
const fs = require('fs');

const listener = app.listen(process.env.PORT, () => console.info(`Your app is listening on port ${listener.address().port}`));

const oneYear = 365 * 24 * 60 * 60;
const thirtyMinutes = 30 * 60;

const config = {
  sourceCache: '/app/sourceCache/',
  pngCache: '/app/pngCache/',
  tempPath: '/app/temp/',
  cacheDuration: 60,
  caching: false
}

app.get('/best', async function(req, res) {
  const startTime = Date.now();
  try {
    const requestUrl = decodeURIComponent(req.query.url);

    // TODO: More signficant URL validation
    if (!requestUrl) {
      res.send('Please supply a URI component encoded url as a URL query parameter');
      return;
    }
    
    const icons = await findAllIcons(requestUrl);
    const validatedIcons = await validateIcons(icons);
    const bestIcon = pickBestIcon(validatedIcons);
    res.json(bestIcon);

    const duration = Date.now() - startTime;
    console.info(`Found ${validatedIcons.length} icons in ${duration}ms`);
  } catch (e) {
    console.warn(e);
    console.trace();
    res.sendStatus(404);
  }

  return;
});

app.get('/', async function(req, res) {
  const startTime = Date.now();
  try {
    const requestUrl = decodeURIComponent(req.query.url);

    // TODO: More signficant URL validation
    if (!requestUrl) {
      res.send('Please supply a URI component encoded url as a URL query parameter');
      return;
    }
    
    const icons = await findAllIcons(requestUrl);
    const validatedIcons = await validateIcons(icons);
    res.json(validatedIcons);

    const duration = Date.now() - startTime;
    console.info(`Found ${validatedIcons.length} icons in ${duration}ms`);
  } catch (e) {
    console.warn(e);
    console.trace();
    res.sendStatus(404);
  }

  return;
});

function pickBestIcon(icons) {
  const order = [
    'shortcutIcon',
    'rootIcon',
    'appleTouchIcon',
    'appleTouchIconPrecomposed',
    'opengraph',
    'twitter',
    'msapplicationTileImage',
    'rootIcon',
    'secondLevelRootIcon',
    'iconImage'
  ];

  const o = icons.reduce(function(acc, icon){
    const iconType = icon.iconType;
    acc[iconType] = icon;
    
    return acc;
  }, {});
  
  try {
    order.forEach(function(key){
      const icon = o[key];
      if (icon) throw icon;
    });
    
    throw { undefined };
  } catch (icon) {
    if (icon) return icon;
  }

  return undefined;
}

async function findAllIcons(requestUrl) {
  const page = await get(requestUrl);

  const requests = [
    findRootIconUrls(requestUrl),
    findPageIconUrls(requestUrl)
  ];
  
  if (page && page.url !== requestUrl) {
    requests.push(findRootIconUrls(page.url));
  }
  
  const icons = (await Promise.all(requests)).flat();
  // find icons in page
  // Validate all icons exist
  return icons;
}

async function findPageIconUrls(html) {
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
  const res = await x(html, 'html', [selectors]);
  var icons = [];
  
  if (res && res[0]) {
    const entries = Object.entries(res[0]);
    
    entries.forEach(function(entry) {
      const url = entry[1];
      const iconType = entry[0];
      icons.push({ url, iconType });
    });
  }
  
  // TODO Do aggressive search of whole DOM looking for images that have 'logo' or 'icon' in the
  // filename. Also try to prioritize square icons
  
  // TODO calculate image dimensions  
  
  if (icons && Object.keys(icons).length === 0) return null;
  return icons;  
}

async function findRootIconUrls(requestUrl) {
  const icons = [];
  const rootIcon = { url: rootIconUrl(requestUrl), iconType: 'rootIcon' };
  icons.push(rootIcon);
  
  const secondLevel = secondLevelDomainUrl(requestUrl);
  if (secondLevel) {
    const secondLevelIcon = rootIconUrl(secondLevel);
    if (secondLevelIcon && secondLevelIcon !== rootIcon) {
      icons.push({ url: secondLevelIcon, iconType: 'secondLevelRootIcon'});
    }
  }
  
  return icons;
}

function rootIconUrl(requestUrl) {
  if (typeof requestUrl !== 'string') return undefined;
  const parsedUrl = Url.parse(requestUrl);
  
  const url = `${parsedUrl.protocol}//${parsedUrl.hostname}/favicon.ico`;
  return url;
}

async function validateIcons(icons) {
  const promises = icons.map(validateIcon);

  const res = (await Promise.all(promises)).flat();
  const filtered = res.filter((icon) => icon.valid);
  const cleaned = res.map(function(icon) {
    delete icon.valid;
    return icon;
  });
  return cleaned;
}

async function validateIcon(icon) {
  const check = await checkUrl(icon.url);
  const isValid = (check && check.ok && isImageMimeType(check));
  const res = {
    valid: isValid,
    mimeType: check.mimeType,
    base64: check.base64,
    ...icon
  };

  return res;
}

function isImageMimeType(res) {
  const imageRe = /image\//i;

  var type = '';
  
  if (typeof res === 'string') type = (res);
  if (typeof res.mimeType === 'string') type = res.mimeType;
  if (res && res.headers && res.headers.has('Content-Type')) type = res.headers.get('Content-Type');
  
  return imageRe.test(type);
}

async function fetchResToResObj(res) {
  return {
    ok: res.ok || false,
    status: res.status || 404,
    redirected: res.redirected || false,
    url: res.url,
    headers: res.headers,
    mimeType: res.headers.get('content-type') || undefined,
    length: res.headers.get('content-length') || undefined,
    base64: (res && res.ok && typeof res.arrayBuffer === 'function' ? arrayBufferToBase64(await res.arrayBuffer()) : undefined)
  };
}

function headersToObj(headers) {
  const entries = [...headers.entries()];
  const obj = entries.reduce(function(acc, cv) {
    const key = cv[0].toLowerCase();
    const value = cv[1];
    
    acc[key] = value;
    
    return acc;
  }, {});
  
  return obj;
}

async function checkUrl(requestUrl, cached=false, getMethod) {
  //const opts = { method: (getMethod ? 'GET' : 'HEAD') };
  const opts = { method: 'GET' }; // Can't use HEAD requests due to bug here: https://github.com/grantila/fetch-h2/issues/70
  
  const failedResponse = {
    ok: false,
    status: 404,
    url: requestUrl,
    redirected: false,
    headers: undefined,
    base64: undefined
  }
 
  try {
    console.info(`Checking ${requestUrl} availability`);
    const res = await get(requestUrl, opts);
    console.info(`${requestUrl} is ${(res && res.ok ? '' : 'not ')}available`);

    return res;
  } catch (e) {
    console.warn(e);
    console.trace();
    return { ...failedResponse, ...{ error: e} };
  }
  
  return false;  
}

async function get(requestUrl, fetchOpts) {    
  const baseOpts = { redirect: 'follow' };
  const opts = { ...baseOpts, ...fetchOpts };
      
  try {
    console.info(`Fetching ${requestUrl}`);
    
    if (isDataUri(requestUrl)) {
      return dataUriToResponse(requestUrl);
    } else {
      return fetchResToResObj(await fetch(requestUrl, opts));
    };
  } catch (e) {
    console.warn(`Unable to fetch ${requestUrl}`);
    console.warn(e);
    return null;
  }
}

function secondLevelDomainUrl(url) {
  const parsed = Url.parse(url);
  const hostname = parsed.hostname;
  const protocol = parsed.protocol;

  const domainRe = /\.([^.\s]+?\.[^.\s]+?)$/i;
  const result = domainRe.exec(hostname);

  if (result && result[1]) {
    return `${protocol}//${result[1]}`;
  }

  return undefined;
}

function getIconPath(hash) {
  return config.sourceCache + hash + '.json';
}

async function iconExists(hash) {
  return await fileExists(getIconPath(hash));
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

function md5(s) {
  return (s ? crypto.createHash('md5').update(s).digest('hex') : null);
}

function isDataUri(uri) {
  const dataUriRe = /data:(image\/(?:png|jpeg));base64,(.*)==/i;  
  return dataUriRe.test(uri);
}

function dataUriToResponse(uri) {
  const dataUriRe = /data:(image\/(?:png|jpeg));base64,(.*)==/i;
  const extracted = dataUriRe.exec(uri);
  const type = extracted[1];
  const base64 = extracted[2]; 
  
  return {
    ok: true,
    status: 200,
    redirected: false,
    url: uri,
    headers: undefined,
    mimeType: type,
    length: base64.length,
    base64: base64
  }

}

const arrayBufferToBase64 = (arrayBuffer) => Buffer.from(arrayBuffer).toString('base64');

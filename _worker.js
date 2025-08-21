// _worker.js
// This file is the entry point for Cloudflare Pages.

// Import the Express app instance from our main application file using CommonJS.
const app = require('./index.js');

// The Cloudflare Pages environment expects a default export with a `fetch` method.
// We provide the Express app instance directly, which Cloudflare can adapt.
module.exports = {
  fetch: app,
};

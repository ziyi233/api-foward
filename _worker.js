// _worker.js
// This file is the entry point for Cloudflare Pages.

// Import the Express app instance from our main application file.
const app = require('./index.js');

// The Cloudflare Pages environment expects a default export with a `fetch` method.
export default {
  fetch: app,
};

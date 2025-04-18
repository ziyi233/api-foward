const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// --- Configuration Loading ---
const configPath = path.join(__dirname, 'config.json');
let currentConfig = {};

function loadConfig() {
    try {
        const rawData = fs.readFileSync(configPath, 'utf8');
        currentConfig = JSON.parse(rawData);
        console.log("Configuration loaded successfully.");
    } catch (error) {
        console.error("Error loading configuration:", error);
        currentConfig = { apiUrls: {}, baseTag: "" };
    }
}

loadConfig(); // Load initial config

// --- Utility Functions ---
function getValueByDotNotation(obj, path) {
    if (!path) return undefined;
    const keys = path.split('.');
    let current = obj;
    for (const key of keys) {
        if (current === null || current === undefined || typeof current !== 'object') {
            return undefined;
        }
        current = current[key];
    }
    return current;
}

async function handleProxyRequest(targetUrl, proxySettings = {}, res) {
    try {
        console.log(`[Proxy] Requesting: ${targetUrl}`);
        const response = await axios.get(targetUrl, {
            timeout: 15000, // Increased timeout slightly
            validateStatus: (status) => status >= 200 && status < 500,
        });

        if (response.status >= 400) {
            console.warn(`[Proxy] Target API returned status ${response.status} for ${targetUrl}`);
            return res.status(response.status).json(response.data || { error: `Target API error (Status ${response.status})` });
        }

        let imageUrl = null;
        const fieldToUse = proxySettings.imageUrlField;

        if (fieldToUse && response.data && typeof response.data === 'object') {
            imageUrl = getValueByDotNotation(response.data, fieldToUse);
            if (typeof imageUrl === 'string' && imageUrl.match(/\.(jpeg|jpg|gif|png|webp|bmp|svg)/i)) {
                console.log(`[Proxy] Image URL found via field '${fieldToUse}': ${imageUrl}`);
            } else {
                console.log(`[Proxy] Field '${fieldToUse}' value is not a valid image URL:`, imageUrl);
                imageUrl = null;
            }
        } else if (fieldToUse) {
             console.log(`[Proxy] Could not find/access field '${fieldToUse}' or response is not an object.`);
        }

        if (imageUrl) {
            console.log(`[Proxy] Redirecting to image URL: ${imageUrl}`);
            return res.redirect(imageUrl);
        } else {
            const fallback = proxySettings.fallbackAction || 'returnJson';
            console.log(`[Proxy] Image URL not found/invalid. Fallback: ${fallback}`);
            if (fallback === 'error') {
                return res.status(404).json({ error: 'Could not extract image URL from target API response.', targetUrl: targetUrl });
            } else {
                return res.json(response.data);
            }
        }
    } catch (error) {
        console.error(`[Proxy] Request failed for ${targetUrl}:`, error.message);
        if (error.response) {
             return res.status(error.response.status).json(error.response.data || { error: 'Proxy target returned an error' });
        } else if (error.request) {
            return res.status(504).json({ error: 'Proxy request timed out or failed', targetUrl: targetUrl });
        } else {
            return res.status(500).json({ error: 'Proxy request setup failed', message: error.message });
        }
    }
}

// --- Express App Setup ---
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Serve static files like admin.html, config.json (for loading)

// --- Configuration Management API ---
app.get('/config', (req, res) => {
    // Send the current in-memory config
    res.json(currentConfig);
});

app.post('/config', (req, res) => {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object' || !newConfig.apiUrls) {
        return res.status(400).json({ error: 'Invalid configuration format.' });
    }
    try {
        // Update in-memory config FIRST
        currentConfig = newConfig;
        // Write updated config back to file (asynchronously)
        fs.writeFile(configPath, JSON.stringify(currentConfig, null, 2), 'utf8', (err) => {
            if (err) {
                console.error('Error writing config file:', err);
                // Attempt to reload previous config if write fails? Or just log error.
                // loadConfig(); // Revert in-memory config if write fails? Risky.
                // For now, just report error but keep in-memory change.
                 res.status(500).json({ error: 'Failed to save configuration file, but in-memory config updated.' });
            } else {
                 console.log("Configuration updated and saved to file.");
                 res.json({ message: 'Configuration updated successfully. Changes are now live.' });
            }
        });
    } catch (error) {
        // Catch potential errors during in-memory update or JSON stringify
        console.error('Error processing new configuration:', error);
        res.status(500).json({ error: 'Failed to process new configuration.' });
    }
});

// --- Wildcard API Route Handler ---
app.get('/:apiKey', async (req, res, next) => {
    const apiKey = req.params.apiKey;
    console.log(`[Router] Received request for /${apiKey}`);

    // Ignore requests for static files handled by express.static
    // Check if the request looks like a file extension common for static assets
     if (apiKey.includes('.') || apiKey === 'favicon.ico') {
         console.log(`[Router] Ignoring likely static file request: /${apiKey}`);
         return next(); // Pass to express.static or 404 handler
     }
     
    // --- Handle Special System Routes ---
     if (apiKey === 'config') { // Let the dedicated /config route handle this
         console.log(`[Router] Passing /config request to dedicated handler.`);
         return next();
     }
     if (apiKey === 'admin.html') { // Let express.static handle this
         console.log(`[Router] Passing /admin.html request to static handler.`);
         return next();
     }
     // Add other potential static files or system routes here if needed

    // --- Lookup API Config ---
    const configEntry = currentConfig.apiUrls ? currentConfig.apiUrls[apiKey] : undefined;

    if (!configEntry || !configEntry.method) {
        console.log(`[Router] No valid configuration found for /${apiKey}. Passing to 404.`);
        return next(); // No config found, let Express handle 404
    }
    console.log(`[Router] Found config for /${apiKey}:`, configEntry);


    // --- Handle Special URL Constructions ---
    if (configEntry.urlConstruction === 'special_forward') {
        console.log(`[Handler /${apiKey}] Using special forward logic.`);
        const targetUrlParam = req.query.url;
        const fieldParam = req.query.field || configEntry.proxySettings?.imageUrlFieldFromParamDefault || 'url';
        if (!targetUrlParam) {
            return res.status(400).json({ error: 'Missing required query parameter: url' });
        }
        const dynamicProxySettings = { ...configEntry.proxySettings, imageUrlField: fieldParam };
        return await handleProxyRequest(targetUrlParam, dynamicProxySettings, res);
    }

    if (configEntry.urlConstruction === 'special_pollinations') {
        console.log(`[Handler /${apiKey}] Using special Pollinations logic.`);
        const tags = req.query.tags;
        if (!tags) {
            return res.status(400).json({ error: 'Missing required query parameter: tags' });
        }
        const baseUrl = configEntry.url; // Use potentially modified base URL
        const modelName = configEntry.modelName;
        const baseTag = currentConfig.baseTag || '';
        const promptUrl = `${baseUrl}${encodeURIComponent(tags)}%2c${baseTag}?&model=${modelName}&nologo=true`;
        console.log(`[Handler /${apiKey}] Redirecting to Pollinations URL: ${promptUrl}`);
        return res.redirect(promptUrl);
    }

    if (configEntry.urlConstruction === 'special_draw_redirect') {
        console.log(`[Handler /${apiKey}] Using special draw redirect logic.`);
        const tags = req.query.tags;
        const modelParamConfig = configEntry.queryParams?.find(p => p.name === 'model');
        const model = req.query.model || modelParamConfig?.defaultValue || 'flux';
        if (!tags) {
            return res.status(400).json({ error: 'Missing required query parameter: tags' });
        }
        const validModels = modelParamConfig?.validValues || ['flux', 'turbo'];
        if (!validModels.includes(model)) {
             return res.status(400).json({ error: `Invalid model parameter. Valid options: ${validModels.join(', ')}` });
        }
        const redirectPath = `/${model}?tags=${encodeURIComponent(tags)}`;
        console.log(`[Handler /${apiKey}] Redirecting /draw to: ${redirectPath}`);
        return res.redirect(redirectPath);
    }

    // --- Generic Handler Logic ---
    console.log(`[Handler /${apiKey}] Using generic logic.`);
    const queryParamsConfig = configEntry.queryParams || [];
    const validatedParams = {};
    const errors = [];

    // 1. Validate Query Parameters
    for (const paramConfig of queryParamsConfig) {
        const paramValue = req.query[paramConfig.name];
        if (paramValue !== undefined) {
            if (paramConfig.validValues && !paramConfig.validValues.includes(paramValue)) {
                errors.push(`Invalid value for parameter '${paramConfig.name}'. Valid: ${paramConfig.validValues.join(', ')}.`);
            } else {
                validatedParams[paramConfig.name] = paramValue;
            }
        } else if (paramConfig.required) {
            errors.push(`Missing required query parameter: ${paramConfig.name}.`);
        } else if (paramConfig.defaultValue !== undefined) {
            validatedParams[paramConfig.name] = paramConfig.defaultValue;
        }
    }

    if (errors.length > 0) {
        return res.status(400).json({ error: 'Invalid query parameters.', details: errors });
    }

    // 2. Construct Target URL
    let targetUrl = configEntry.url; // Use potentially modified base URL
    if (!targetUrl) {
         console.error(`[Handler /${apiKey}] Error: Configuration URL is missing.`);
         return res.status(500).json({ error: "Internal server error: API configuration URL is missing." });
    }
    if (Object.keys(validatedParams).length > 0) {
        try {
            const base = new URL(targetUrl); // Use URL constructor to handle existing params
            Object.entries(validatedParams).forEach(([key, value]) => {
                base.searchParams.append(key, value);
            });
            targetUrl = base.toString();
        } catch(e) {
             // Fallback for potentially invalid base URLs in config, just append
             console.warn(`[Handler /${apiKey}] Could not parse base URL, appending params directly. Error: ${e.message}`);
             const urlSearchParams = new URLSearchParams(validatedParams);
             targetUrl += (targetUrl.includes('?') ? '&' : '?') + urlSearchParams.toString();
        }
    }
    console.log(`[Handler /${apiKey}] Constructed target URL: ${targetUrl}`);

    // 3. Handle Request based on Method
    if (configEntry.method === 'proxy') {
        return await handleProxyRequest(targetUrl, configEntry.proxySettings, res);
    } else { // 'redirect'
        try {
            console.log(`[Handler /${apiKey}] Redirecting to: ${targetUrl}`);
            return res.redirect(targetUrl);
        } catch (error) {
            console.error(`[Handler /${apiKey}] Error during redirect:`, error.message);
            return res.status(500).json({ error: `Failed to redirect for ${apiKey}` });
        }
    }
});


// --- Home Route ---
// Needs to be registered *before* the wildcard route or be handled differently
app.get('/', (req, res) => {
    console.log("[Router] Handling request for /");
    // Group endpoints by group name
    const groupedApis = {};
    for (const key in currentConfig.apiUrls) {
        const entry = currentConfig.apiUrls[key];
        const group = entry.group || '未分组';
        if (!groupedApis[group]) {
            groupedApis[group] = [];
        }
        groupedApis[group].push({ key, ...entry });
    }

    // Sort groups
    const sortedGroups = Object.keys(groupedApis).sort((a, b) => {
        const order = {'通用转发': 1, 'AI绘图': 2, '二次元图片': 3, '三次元图片': 4, '表情包': 5, '未分组': 99};
        return (order[a] || 99) - (order[b] || 99);
    });

    let groupedApiHtml = '';
    sortedGroups.forEach(groupName => {
        groupedApiHtml += `<h3 class="mt-4">${groupName}</h3>`;
        let apiTableHtml = `
        <div class="table-responsive">
        <table class="table table-striped table-hover table-bordered table-sm">
            <thead>
                <tr>
                    <th scope="col" class="text-nowrap">端点路径</th>
                    <th scope="col">描述</th>
                    <th scope="col" class="text-nowrap">处理方式</th>
                    <th scope="col">参数</th>
                </tr>
            </thead>
            <tbody>`;

        // Sort endpoints within the group
        groupedApis[groupName].sort((a, b) => a.key.localeCompare(b.key));

        groupedApis[groupName].forEach(entry => {
            const key = entry.key; // Get the key
            let paramsDesc = '';
            if (entry.queryParams && entry.queryParams.length > 0) {
            paramsDesc = entry.queryParams.map(p => {
                 let desc = `<code class="text-nowrap">${p.name}</code>`;
                 if(p.required) desc += '<span class="text-danger fw-bold" title="必需参数">*</span>';
                 if(p.defaultValue) desc += ` <small class="text-muted">(默认: ${p.defaultValue})</small>`;
                 if(p.description) desc += `<br><small class="text-muted fst-italic">${p.description}</small>`; // Description on new line
                 return desc;
            }).join('<hr class="my-1">'); // Separator between params
        } else {
            paramsDesc = '<em class="text-muted">无</em>';
        }

        apiTableHtml += `
                <tr>
                    <td class="text-nowrap"><code>/${key}</code></td>
                    <td>${entry.description || '<em class="text-muted">无描述</em>'}</td>
                    <td class="text-nowrap">${entry.method === 'proxy' ? '<span class="badge bg-primary">服务器代理</span>' : '<span class="badge bg-secondary">浏览器重定向</span>'}</td>
                    <td>${paramsDesc}</td>
                </tr>`;
        }); // End loop for endpoints within group

        apiTableHtml += `
            </tbody>
        </table>
        </div>`;
        groupedApiHtml += apiTableHtml; // Add table for the group
    }); // End loop for groups

    groupedApiHtml += `<p class="text-muted mt-2"><small><span class="text-danger fw-bold">*</span> 表示必需参数</small></p>`;


    // Construct the full HTML page with Bootstrap 5
    res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>API 转发服务</title>
        <!-- 新 Bootstrap5 核心 CSS 文件 -->
        <link rel="stylesheet" href="https://lf26-cdn-tos.bytecdntp.com/cdn/expire-1-M/twitter-bootstrap/5.1.3/css/bootstrap.min.css">
        <!-- Optional: Bootstrap Icons CDN -->
         <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">
        <style>
            body { padding-top: 1.5rem; padding-bottom: 3rem; background-color: #f8f9fa; }
            .container { max-width: 1140px; }
            .card img { max-height: 250px; object-fit: contain; }
            .table td, .table th { vertical-align: middle; }
            code { font-size: 0.875em; }
            hr.my-1 { margin-top: 0.25rem !important; margin-bottom: 0.25rem !important; opacity: 0.1;}
        </style>
    </head>
    <body>
        <main class="container">
            <div class="p-5 mb-4 bg-light rounded-3">
              <div class="container-fluid py-5">
                <h1 class="display-5 fw-bold">API 转发服务</h1>
                <p class="col-md-8 fs-4">使用此服务转发 API 请求。所有配置均可通过<a href="/admin.html" class="link-primary">管理页面</a>动态修改。</p>
                 <a href="/admin.html" class="btn btn-primary btn-lg" role="button"><i class="bi bi-gear-fill"></i> 前往管理页面</a>
              </div>
            </div>

            <div class="card mb-4">
                <div class="card-header"><h2 class="h5 mb-0">可用 API 端点</h2></div>
                <div class="card-body">
                    ${groupedApiHtml} 
                </div>
            </div>

            <div class="card">
                 <div class="card-header"><h2 class="h5 mb-0">示例</h2></div>
                 <div class="card-body">
                    <div class="row row-cols-1 row-cols-md-3 g-4">
                        <div class="col">
                            <div class="card h-100 text-center">
                                <img src="/doro" class="card-img-top p-3" alt="随机 doro 贴纸">
                                <div class="card-footer text-muted"><small>随机 Doro 贴纸 (<code>/doro</code>)</small></div>
                            </div>
                        </div>
                         <div class="col">
                            <div class="card h-100 text-center">
                                <img src="/anime1" class="card-img-top p-3" alt="随机二次元图片">
                                <div class="card-footer text-muted"><small>随机二次元图片 (<code>/anime1</code>)</small></div>
                            </div>
                        </div>
                         <div class="col">
                            <div class="card h-100 text-center">
                                <img src="/baisi" class="card-img-top p-3" alt="白丝图片">
                                <div class="card-footer text-muted"><small>白丝图片 (<code>/baisi</code>)</small></div>
                            </div>
                        </div>
                    </div>
                    <p class="text-muted mt-3"><small>注意：示例图片可能因 API 端点配置更改而变化。</small></p>
                 </div>
            </div>
        </main>
        <!-- Popper.js -->
        <script src="https://lf6-cdn-tos.bytecdntp.com/cdn/expire-1-M/popper.js/2.11.2/umd/popper.min.js"></script>
        <!-- Bootstrap 5 JS -->
        <script src="https://lf26-cdn-tos.bytecdntp.com/cdn/expire-1-M/twitter-bootstrap/5.1.3/js/bootstrap.min.js"></script>
    </body>
    </html>
                    </figure>
                </div>
                <small>注意：示例图片可能因 API 端点配置更改而变化。</small>
            </article>
        </main>
    </body>
    </html>
    `);
});


// --- Server Start ---
app.listen(PORT, () => {
    console.log(`API Forwarder running on http://localhost:${PORT}`);
    console.log(`Admin interface available at http://localhost:${PORT}/admin.html`);
});

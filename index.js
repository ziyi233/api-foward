const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

// --- MongoDB Configuration ---
// 从环境变量中读取MongoDB连接信息
const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || "api-forward";
const collectionName = process.env.MONGODB_COLLECTION_NAME || "config";

// 检查是否提供了必要的环境变量
if (!mongoUri) {
    console.warn("警告: 未设置MONGODB_URI环境变量。MongoDB功能将不可用，仅使用本地文件存储配置。");
}

// 仅当提供了MongoDB URI时才创建客户端
const mongoClient = mongoUri ? new MongoClient(mongoUri) : null;

// 安全地记录配置信息，不显示敏感信息
if (mongoUri) {
    const hiddenUri = mongoUri.includes('@') 
        ? `${mongoUri.substring(0, mongoUri.indexOf('://') + 3)}[CREDENTIALS_HIDDEN]${mongoUri.substring(mongoUri.indexOf('@'))}`
        : "[MONGODB_URI_HIDDEN]";
    console.log(`MongoDB配置: URI=${hiddenUri}, DB=${dbName}, Collection=${collectionName}`);
}

// --- 环境配置 ---
// 是否允许文件操作（默认不允许，适合Vercel等只读环境）
// 设置 ENABLE_FILE_OPERATIONS=true 来允许文件操作
const enableFileOperations = process.env.ENABLE_FILE_OPERATIONS === 'true';

// --- Configuration Loading ---
const configPath = path.join(__dirname, 'config.json');
let currentConfig = {};

async function loadConfig() {
    let configLoaded = false;
    
    // 尝试从MongoDB加载配置（如果MongoDB客户端存在）
    if (mongoClient) {
        try {
            await mongoClient.connect();
            const db = mongoClient.db(dbName);
            const collection = db.collection(collectionName);
            const doc = await collection.findOne({});
            
            if (doc && doc.data) {
                currentConfig = doc.data;
                console.log("Configuration loaded from MongoDB.");
                configLoaded = true;
                
                // 如果允许文件操作，备份到本地文件
                if (enableFileOperations) {
                    try {
                        fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2), 'utf8');
                        console.log("Configuration backed up to local file.");
                    } catch (writeError) {
                        console.error("Error backing up configuration to file:", writeError);
                    }
                }
            } else {
                console.log("No configuration found in MongoDB.");
                // MongoDB中没有配置，尝试从本地文件加载并写入MongoDB
                try {
                    if (fs.existsSync(configPath)) {
                        const rawData = fs.readFileSync(configPath, 'utf8');
                        currentConfig = JSON.parse(rawData);
                        console.log("Configuration loaded from local file and will be saved to MongoDB.");
                        
                        // 将本地配置写入MongoDB
                        await collection.updateOne({}, { $set: { data: currentConfig } }, { upsert: true });
                        console.log("Local configuration saved to MongoDB.");
                        configLoaded = true;
                    }
                } catch (fileError) {
                    console.error("Error loading configuration from local file:", fileError);
                }
            }
        } catch (mongoError) {
            console.error("Error connecting to MongoDB:", mongoError);
        } finally {
            try {
                await mongoClient.close();
            } catch (error) {
                console.error("Error closing MongoDB connection:", error);
            }
        }
    } else {
        console.log("MongoDB client not initialized.");
    }
    
    // 如果配置还未加载且允许文件操作，尝试从本地文件加载
    if (!configLoaded && enableFileOperations) {
        try {
            if (fs.existsSync(configPath)) {
                const rawData = fs.readFileSync(configPath, 'utf8');
                currentConfig = JSON.parse(rawData);
                console.log("Configuration loaded from local file.");
                configLoaded = true;
            }
        } catch (fileError) {
            console.error("Error loading configuration from file:", fileError);
        }
    }
    
    // 如果配置仍然未加载，使用默认空配置
    if (!configLoaded) {
        console.log("No configuration found. Using default empty configuration.");
        currentConfig = { apiUrls: {}, baseTag: "" };
    }
}

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
// Serve static files like config.json (for loading in admin page)
// We will handle admin.html explicitly below.
app.use(express.static(path.join(__dirname)));

// --- Configuration Management API ---
app.get('/config', (req, res) => {
    // Send the current in-memory config
    res.json(currentConfig);
});

app.post('/config', async (req, res) => {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object' || !newConfig.apiUrls) {
        return res.status(400).json({ error: 'Invalid configuration format.' });
    }
    try {
        // 首先更新内存中的配置
        currentConfig = newConfig;
        
        // 尝试保存到MongoDB（如果MongoDB客户端存在）
        let mongoSuccess = false;
        if (mongoClient) {
            try {
                await mongoClient.connect();
                const db = mongoClient.db(dbName);
                const collection = db.collection(collectionName);
                await collection.updateOne({}, { $set: { data: currentConfig } }, { upsert: true });
                console.log("Configuration saved to MongoDB.");
                mongoSuccess = true;
            } catch (mongoError) {
                console.error('Error saving to MongoDB:', mongoError);
            } finally {
                try {
                    await mongoClient.close();
                } catch (error) {
                    console.error("Error closing MongoDB connection:", error);
                }
            }
        } else {
            console.log("MongoDB client not initialized. Skipping MongoDB save.");
        }
        
        // 如果允许文件操作，尝试写入本地文件作为备份
        if (enableFileOperations) {
            fs.writeFile(configPath, JSON.stringify(currentConfig, null, 2), 'utf8', (err) => {
                if (err) {
                    console.error('Error writing config file:', err);
                    if (mongoClient && !mongoSuccess) {
                        // MongoDB可用但保存失败，且文件写入也失败
                        return res.status(500).json({ 
                            error: 'Failed to save configuration to both MongoDB and file, but in-memory config updated.' 
                        });
                    } else if (mongoClient) {
                        // MongoDB可用且保存成功，但文件写入失败
                        return res.json({ 
                            message: 'Configuration saved to MongoDB but backup to file failed. Changes are now live.' 
                        });
                    } else {
                        // MongoDB不可用，且文件写入失败
                        return res.status(500).json({ 
                            error: 'Failed to save configuration to file and MongoDB is not available. In-memory config is updated.' 
                        });
                    }
                } else {
                    console.log("Configuration saved to local file.");
                    if (mongoClient) {
                        return res.json({ 
                            message: mongoSuccess 
                                ? 'Configuration updated successfully and saved to both MongoDB and file. Changes are now live.' 
                                : 'Configuration saved to file but MongoDB update failed. Changes are now live.'
                        });
                    } else {
                        return res.json({ 
                            message: 'Configuration saved to local file. MongoDB is not available. Changes are now live.'
                        });
                    }
                }
            });
        } else {
            // 不允许文件操作，只依赖MongoDB
            console.log("File operations disabled, skipping file write operations.");
            if (mongoClient) {
                if (mongoSuccess) {
                    return res.json({ 
                        message: 'Configuration saved to MongoDB. Changes are now live.' 
                    });
                } else {
                    return res.status(500).json({ 
                        error: 'Failed to save configuration to MongoDB, but in-memory config updated.' 
                    });
                }
            } else {
                // 没有MongoDB配置且不允许文件操作
                return res.status(500).json({ 
                    error: 'No persistent storage available. Configuration only updated in memory and will be lost on server restart.' 
                });
            }
        }
    } catch (error) {
        // 捕获内存更新或JSON序列化过程中的潜在错误
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
     if (apiKey === 'admin') { // Let the dedicated /admin route handle this
         console.log(`[Router] Passing /admin request to dedicated handler.`);
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


// --- Home Route (API List & Examples) ---
// Needs to be registered *before* the wildcard route
app.get('/', (req, res) => {
    console.log("[Router] Handling request for / (Home Page)");
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
    const homeHtmlContent = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API 转发服务</title>
    <!-- 新 Bootstrap5 核心 CSS 文件 -->
    <link rel="stylesheet" href="https://lf26-cdn-tos.bytecdntp.com/cdn/expire-1-M/twitter-bootstrap/5.1.3/css/bootstrap.min.css">
    <!-- Optional: Bootstrap Icons CDN (using cdnjs) -->
     <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap-icons/1.11.3/font/bootstrap-icons.min.css">
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
            <p class="col-md-8 fs-4">使用此服务转发 API 请求。所有配置均可通过管理页面动态修改。</p>
             <a href="/admin" class="btn btn-primary btn-lg" role="button"><i class="bi bi-gear-fill"></i> 前往管理页面</a>
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
`;
    res.setHeader('Content-Type', 'text/html');
    res.send(homeHtmlContent);
});

// --- Admin Interface Route ---
app.get('/admin', (req, res) => {
    console.log("[Router] Handling request for /admin (Admin Interface)");
    const adminHtmlContent = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API 转发配置管理 (Bootstrap)</title>
    <!-- 新 Bootstrap5 核心 CSS 文件 -->
    <link rel="stylesheet" href="https://lf26-cdn-tos.bytecdntp.com/cdn/expire-1-M/twitter-bootstrap/5.1.3/css/bootstrap.min.css">
    <!-- Optional: Bootstrap Icons CDN (using cdnjs) -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap-icons/1.11.3/font/bootstrap-icons.min.css">
    <style>
        body { background-color: #f8f9fa; padding-top: 1.5rem; padding-bottom: 3rem; }
        .container { max-width: 960px; }
        .card { margin-bottom: 1.5rem; }
        .card-header { background-color: rgba(0, 123, 255, 0.05); font-weight: bold; display: flex; justify-content: space-between; align-items: center; }
        .api-key-input { font-weight: bold; border: none; border-bottom: 1px dashed #0d6efd; padding: 2px 5px; background: transparent; color: #0d6efd; margin-left: 0.25rem; width: auto; max-width: 250px; }
        .api-key-input:focus { outline: none; border-bottom-style: solid; }
        .config-item { margin-bottom: 1rem; }
        .config-item label { font-weight: 500; color: #495057; }
        .proxy-settings, .query-params { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #eee; }
        .param-item { border: 1px solid #e9ecef; padding: 1rem; margin-bottom: 1rem; border-radius: 0.375rem; background-color: #fff; position: relative; }
        .param-item .remove-param-button { position: absolute; top: 0.5rem; right: 0.5rem; }
        .tooltip-icon { cursor: help; color: #6c757d; margin-left: 0.25rem; }
        #message { margin-top: 1.5rem; }
        .btn-sm { padding: 0.25rem 0.5rem; font-size: 0.875rem; }
        .add-endpoint-button { margin-bottom: 1.5rem; }
        .group-title { margin-top: 2rem; margin-bottom: 1rem; font-size: 1.5rem; color: #6c757d; border-bottom: 2px solid #dee2e6; padding-bottom: 0.5rem; }
        .global-setting-item { padding: 1rem; border: 1px solid #cfe2ff; background-color: #ecf5ff; border-radius: 0.375rem; margin-bottom: 1.5rem; }
    </style>
</head>
<body>
    <main class="container">
        <div class="d-flex justify-content-between align-items-center mb-4">
             <h1 class="h3">API 转发配置管理</h1>
             <button type="button" class="btn btn-success add-endpoint-button" onclick="addApiEndpoint()"><i class="bi bi-plus-lg"></i> 添加新 API 端点</button>
        </div>

        <p class="text-muted mb-4">在这里修改、添加或删除 API 转发规则。所有更改将**立即生效**。</p>

        <form id="config-form">
            <div id="api-configs-container">
                <!-- Initial Loading Indicator -->
                <div class="text-center">
                    <div class="spinner-border text-primary" role="status">
                        <span class="visually-hidden">正在加载配置...</span>
                    </div>
                    <p class="mt-2">正在加载配置...</p>
                </div>
            </div>

            <!-- Global settings will be injected into the correct group by JS -->
            <div id="global-settings-placeholder" style="display: none;">
                 <div class="row mb-3 align-items-center global-setting-item">
                     <label for="baseTag" class="col-sm-3 col-form-label text-sm-end" title="用于 AI 绘图 API 的通用附加标签">全局基础 Tag:</label>
                     <div class="col-sm-8">
                         <input type="text" class="form-control" id="baseTag" name="baseTag" placeholder="例如: masterpiece%20best%20quality">
                     </div>
                     <div class="col-sm-1">
                          <i class="bi bi-info-circle tooltip-icon" data-bs-toggle="tooltip" data-bs-placement="top" title="这个 Tag 会自动附加到 AI 绘图请求的末尾，以提升图像质量。请使用 URL 编码格式。"></i>
                     </div>
                 </div>
            </div>


            <button type="submit" class="btn btn-primary w-100 btn-lg save-button mt-4">
                <i class="bi bi-save"></i> 保存所有配置
            </button>
        </form>
        <div id="message" class="alert mt-4" role="alert" style="display: none;"></div>
    </main>

    <!-- Bootstrap 5 JS Bundle CDN -->
    <script src="https://lf6-cdn-tos.bytecdntp.com/cdn/expire-1-M/popper.js/2.11.2/umd/popper.min.js"></script>
    <script src="https://lf26-cdn-tos.bytecdntp.com/cdn/expire-1-M/twitter-bootstrap/5.1.3/js/bootstrap.min.js"></script>
    <script>
        const form = document.getElementById('config-form');
        const apiConfigsContainer = document.getElementById('api-configs-container');
        // Get baseTag input from placeholder initially
        const globalSettingsPlaceholder = document.getElementById('global-settings-placeholder');
        const baseTagInput = globalSettingsPlaceholder.querySelector('#baseTag');
        const messageDiv = document.getElementById('message');
        let currentConfigData = { apiUrls: {}, baseTag: "" };
        let bootstrapTooltipList = [];

        function showMessage(text, type = 'success') {
            messageDiv.textContent = text;
            messageDiv.className = \`alert alert-\${type === 'success' ? 'success' : 'danger'} mt-4\`;
            messageDiv.style.display = 'block';
            messageDiv.setAttribute('role', 'alert');
            messageDiv.scrollIntoView({ behavior: 'smooth', block: 'end' });
            setTimeout(() => {
                 messageDiv.style.display = 'none';
            }, 7000);
        }

        function sanitizeApiKey(key) {
            return key.replace(/^\\//, '').replace(/[^a-zA-Z0-9-_]/g, '_');
        }

        function initializeTooltips(container) {
            if (typeof bootstrap === 'undefined' || typeof bootstrap.Tooltip === 'undefined') {
                console.warn('Bootstrap Tooltip component not ready yet, skipping initialization.');
                return;
            }
            const tooltipTriggerList = [].slice.call(container.querySelectorAll('[data-bs-toggle="tooltip"]'));
            const newTooltips = tooltipTriggerList.map(function (tooltipTriggerEl) {
                const existingTooltip = bootstrap.Tooltip.getInstance(tooltipTriggerEl);
                if (existingTooltip) { existingTooltip.dispose(); }
                try { return new bootstrap.Tooltip(tooltipTriggerEl); }
                catch (e) { console.error("Failed to initialize tooltip:", tooltipTriggerEl, e); return null; }
            }).filter(Boolean);
            bootstrapTooltipList = bootstrapTooltipList.concat(newTooltips);
        }

        function disposeAllTooltips() {
             if (typeof bootstrap !== 'undefined' && bootstrap.Tooltip) {
                 bootstrapTooltipList.forEach(tooltip => { try { tooltip.dispose(); } catch (e) { console.warn("Error disposing tooltip:", e); } });
             }
             bootstrapTooltipList = [];
        }

        function renderApiEndpoint(apiKey, configEntry) {
            const card = document.createElement('div');
            card.className = 'card';
            card.setAttribute('data-api-key', apiKey);

            const cardHeader = document.createElement('div');
            cardHeader.className = 'card-header';
            cardHeader.innerHTML = \`
                <span>端点: /<input type="text" value="\${apiKey}" class="api-key-input" aria-label="API 端点路径" placeholder="路径名" required></span>
                <button type="button" class="btn btn-danger btn-sm delete-endpoint-button" aria-label="删除此端点" onclick="removeApiEndpoint(this.closest('.card'))">
                    <i class="bi bi-trash"></i> 删除
                </button>\`;
            card.appendChild(cardHeader);

            const cardBody = document.createElement('div');
            cardBody.className = 'card-body';

            // Group Input
            cardBody.innerHTML += \`
                <div class="row mb-3 align-items-center">
                    <label for="\${apiKey}-group" class="col-sm-3 col-form-label text-sm-end" title="用于分类显示的组名">分组:</label>
                    <div class="col-sm-9">
                        <input type="text" class="form-control" id="\${apiKey}-group" name="\${apiKey}-group" value="\${configEntry.group || ''}" placeholder="例如: AI绘图, 表情包">
                    </div>
                </div>\`;

            // Description, URL, Method... (rest of the innerHTML generation is the same as before)
             // Description
            cardBody.innerHTML += \`
                <div class="row mb-3 align-items-center">
                    <label for="\${apiKey}-description" class="col-sm-3 col-form-label text-sm-end" title="这个 API 端点的用途说明">描述:</label>
                    <div class="col-sm-9">
                        <textarea class="form-control" id="\${apiKey}-description" name="\${apiKey}-description" placeholder="例如：获取随机猫咪图片">\${configEntry.description || ''}</textarea>
                    </div>
                </div>\`;

            // URL
            cardBody.innerHTML += \`
                <div class="row mb-3 align-items-center">
                    <label for="\${apiKey}-url" class="col-sm-3 col-form-label text-sm-end" title="目标 API 的基础地址">目标 URL:</label>
                    <div class="col-sm-8">
                        <input type="url" class="form-control" id="\${apiKey}-url" name="\${apiKey}-url" value="\${configEntry.url || ''}" placeholder="https://api.example.com/data" required>
                    </div>
                     <div class="col-sm-1">
                         \${configEntry.urlConstruction && configEntry.urlConstruction.startsWith('special_') ? '<i class="bi bi-exclamation-triangle-fill text-warning tooltip-icon" data-bs-toggle="tooltip" data-bs-placement="top" title="注意: 此端点原配置包含特殊 URL 构建逻辑 ('+configEntry.urlConstruction+'), 修改基础 URL 可能影响其功能。"></i>' : ''}
                     </div>
                </div>\`;

            // Method Dropdown
            cardBody.innerHTML += \`
                <div class="row mb-3 align-items-center">
                    <label for="\${apiKey}-method" class="col-sm-3 col-form-label text-sm-end" title="服务器处理此请求的方式">处理方式:</label>
                    <div class="col-sm-8">
                        <select class="form-select" id="\${apiKey}-method" name="\${apiKey}-method">
                            <option value="redirect" \${configEntry.method === 'redirect' ? 'selected' : ''}>浏览器重定向 (302)</option>
                            <option value="proxy" \${configEntry.method === 'proxy' ? 'selected' : ''}>服务器代理请求</option>
                        </select>
                    </div>
                     <div class="col-sm-1">
                         <i class="bi bi-info-circle tooltip-icon" data-bs-toggle="tooltip" data-bs-placement="top" title='"重定向": 服务器告诉浏览器去访问目标 URL。"代理": 服务器代替浏览器去访问目标 URL，然后将结果返回给浏览器。'></i>
                     </div>
                </div>\`;

            // Proxy Settings Container
            const proxySettingsDiv = document.createElement('div');
            proxySettingsDiv.className = 'proxy-settings mt-3 pt-3 border-top';
            proxySettingsDiv.style.display = configEntry.method === 'proxy' ? 'block' : 'none';
            proxySettingsDiv.innerHTML = '<h5>代理设置</h5>';

            // Image URL Field
            proxySettingsDiv.innerHTML += \`
                <div class="row mb-3 align-items-center">
                    <label for="\${apiKey}-imageUrlField" class="col-sm-3 col-form-label text-sm-end" title="如果目标 API 返回 JSON，指定包含图片链接的字段路径">图片链接字段:</label>
                    <div class="col-sm-8">
                        <input type="text" class="form-control" id="\${apiKey}-imageUrlField" name="\${apiKey}-imageUrlField" value="\${configEntry.proxySettings?.imageUrlField || ''}" placeholder="例如: data.url 或 image" \${apiKey === 'forward' ? 'readonly' : ''}>
                    </div>
                     <div class="col-sm-1">
                         <i class="bi bi-info-circle tooltip-icon" data-bs-toggle="tooltip" data-bs-placement="top" title="\${apiKey === 'forward' ? "对于 /forward 路由，此设置由 'field' 查询参数动态决定（默认为 'url'）。" : '用于从 JSON 响应中提取图片链接。支持用点(.)访问嵌套字段，如 "result.data.imageUrl"。如果为空，则不尝试提取。'}"></i>
                     </div>
                </div>\`;
             if (apiKey === 'forward') {
                 const input = proxySettingsDiv.querySelector(\`#\${apiKey}-imageUrlField\`);
                 if(input) input.value = "(由 'field' 参数决定)";
             }


            // Fallback Action Dropdown
            proxySettingsDiv.innerHTML += \`
                <div class="row mb-3 align-items-center">
                    <label for="\${apiKey}-fallbackAction" class="col-sm-3 col-form-label text-sm-end" title="当无法提取到图片链接时的处理方式">提取图片失败时:</label>
                    <div class="col-sm-8">
                        <select class="form-select" id="\${apiKey}-fallbackAction" name="\${apiKey}-fallbackAction">
                            <option value="returnJson" \${(configEntry.proxySettings?.fallbackAction === 'returnJson' || !configEntry.proxySettings?.fallbackAction) ? 'selected' : ''}>返回原始 JSON</option>
                            <option value="error" \${configEntry.proxySettings?.fallbackAction === 'error' ? 'selected' : ''}>返回错误信息</option>
                        </select>
                    </div>
                     <div class="col-sm-1">
                          <i class="bi bi-info-circle tooltip-icon" data-bs-toggle="tooltip" data-bs-placement="top" title='如果设置了“图片链接字段”但无法找到有效的图片链接，服务器应如何响应。'></i>
                     </div>
                </div>\`;
            cardBody.appendChild(proxySettingsDiv);

            // Query Parameters Container
            const queryParamsDiv = document.createElement('div');
            queryParamsDiv.className = 'query-params mt-3 pt-3 border-top';
            queryParamsDiv.innerHTML = '<h5>查询参数配置</h5>';
            const paramsListDiv = document.createElement('div');
            paramsListDiv.id = \`\${apiKey}-params-list\`;

            (configEntry.queryParams || []).forEach((param, index) => {
                renderQueryParam(paramsListDiv, apiKey, param, index);
            });

            queryParamsDiv.appendChild(paramsListDiv);

            const addParamButton = document.createElement('button');
            addParamButton.type = 'button';
            addParamButton.innerHTML = '<i class="bi bi-plus-circle"></i> 添加查询参数';
            addParamButton.className = 'btn btn-outline-secondary btn-sm add-param-button mt-2';
            addParamButton.onclick = () => addQueryParam(paramsListDiv, apiKey);
            queryParamsDiv.appendChild(addParamButton);

            cardBody.appendChild(queryParamsDiv);
            card.appendChild(cardBody);


            // Event listener to toggle proxy settings visibility
            const methodSelect = cardBody.querySelector(\`#\${apiKey}-method\`);
            methodSelect.addEventListener('change', (event) => {
                proxySettingsDiv.style.display = event.target.value === 'proxy' ? 'block' : 'none';
            });

            return card;
        }

        function renderConfig() {
            disposeAllTooltips();
            apiConfigsContainer.innerHTML = '';

            const apiUrls = currentConfigData.apiUrls || {};
            const groupedEndpoints = {};

            for (const apiKey in apiUrls) {
                const entry = apiUrls[apiKey];
                const group = entry.group || '未分组';
                if (!groupedEndpoints[group]) { groupedEndpoints[group] = []; }
                groupedEndpoints[group].push({ key: apiKey, config: entry });
            }

            const sortedGroups = Object.keys(groupedEndpoints).sort((a, b) => {
                 const order = {'通用转发': 1, 'AI绘图': 2, '二次元图片': 3, '三次元图片': 4, '表情包': 5, '未分组': 99};
                 return (order[a] || 99) - (order[b] || 99);
            });

            if (sortedGroups.length === 0) {
                 apiConfigsContainer.innerHTML = '<div class="alert alert-info">当前没有配置任何 API 端点。点击“添加新 API 端点”开始。</div>';
            } else {
                sortedGroups.forEach(groupName => {
                    const groupContainer = document.createElement('div'); // Container for the group
                    groupContainer.id = \`group-\${groupName.replace(/\\s+/g, '-')}\`; // Create an ID for the group container

                    const groupTitle = document.createElement('h2');
                    groupTitle.className = 'group-title';
                    groupTitle.textContent = groupName;
                    groupContainer.appendChild(groupTitle); // Add title to group container

                    // Inject Global Settings into AI Group
                    if (groupName === 'AI绘图') {
                         const globalSettingElement = globalSettingsPlaceholder.querySelector('.global-setting-item').cloneNode(true);
                         groupContainer.appendChild(globalSettingElement);
                    }

                    // Sort and render endpoints within the group
                    groupedEndpoints[groupName].sort((a, b) => a.key.localeCompare(b.key));
                    groupedEndpoints[groupName].forEach(item => {
                        const cardElement = renderApiEndpoint(item.key, item.config);
                        groupContainer.appendChild(cardElement); // Add card to group container
                    });

                    apiConfigsContainer.appendChild(groupContainer); // Add the whole group container
                });
            }

            // Ensure baseTagInput refers to the one potentially moved into the DOM
            const finalBaseTagInput = document.getElementById('baseTag');
            if (finalBaseTagInput) {
                 finalBaseTagInput.value = currentConfigData.baseTag || '';
            } else {
                 console.error("BaseTag input element not found after rendering!");
            }

            setTimeout(() => initializeTooltips(document.body), 100);
        }

        function renderQueryParam(container, apiKey, param, index) {
             const paramDiv = document.createElement('div');
             paramDiv.className = 'param-item p-3 mb-3';
             const uniquePrefix = \`\${apiKey}-param-\${index}\`;

             paramDiv.innerHTML = \`
                <button type="button" class="btn btn-danger btn-sm remove-param-button" title="移除此参数" onclick="removeQueryParam(this)"><i class="bi bi-x-lg"></i></button>
                <div class="row mb-2 align-items-center">
                    <label for="\${uniquePrefix}-name" class="col-sm-3 col-form-label text-sm-end" title="URL 中的参数名">参数名称:</label>
                    <div class="col-sm-9">
                        <input type="text" class="form-control form-control-sm" id="\${uniquePrefix}-name" name="\${uniquePrefix}-name" value="\${param.name || ''}" required placeholder="例如: keyword">
                    </div>
                </div>
                <div class="row mb-2 align-items-center">
                    <label for="\${uniquePrefix}-desc" class="col-sm-3 col-form-label text-sm-end" title="参数用途说明">参数描述:</label>
                    <div class="col-sm-9">
                        <textarea class="form-control form-control-sm" id="\${uniquePrefix}-desc" name="\${uniquePrefix}-desc" placeholder="例如: 搜索关键词">\${param.description || ''}</textarea>
                    </div>
                </div>
                 <div class="row mb-2 align-items-center">
                    <label for="\${uniquePrefix}-required" class="col-sm-3 form-check-label text-sm-end" title="请求时必须提供此参数">是否必需:</label>
                     <div class="col-sm-9">
                        <div class="form-check form-switch">
                             <input class="form-check-input" type="checkbox" role="switch" id="\${uniquePrefix}-required" name="\${uniquePrefix}-required" \${param.required ? 'checked' : ''}>
                        </div>
                    </div>
                </div>
                 <div class="row mb-2 align-items-center">
                    <label for="\${uniquePrefix}-default" class="col-sm-3 col-form-label text-sm-end" title="未提供参数时的默认值">默认值:</label>
                    <div class="col-sm-9">
                        <input type="text" class="form-control form-control-sm" id="\${uniquePrefix}-default" name="\${uniquePrefix}-default" value="\${param.defaultValue || ''}" placeholder="可选">
                    </div>
                </div>
                 <div class="row mb-2 align-items-center">
                    <label for="\${uniquePrefix}-validValues" class="col-sm-3 col-form-label text-sm-end" title="限制参数的有效值（逗号分隔）">有效值:</label>
                    <div class="col-sm-8">
                        <input type="text" class="form-control form-control-sm" id="\${uniquePrefix}-validValues" name="\${uniquePrefix}-validValues" value="\${(param.validValues || []).join(',')}" placeholder="可选, 例如: value1,value2">
                    </div>
                     <div class="col-sm-1">
                         <i class="bi bi-info-circle tooltip-icon" data-bs-toggle="tooltip" data-bs-placement="top" title='如果填写，参数值必须是列表中的一个（用逗号分隔）。留空则不限制。'></i>
                     </div>
                </div>
             \`;
             container.appendChild(paramDiv);
             setTimeout(() => initializeTooltips(paramDiv), 50);
        }

        function addQueryParam(container, apiKey) {
            const existingParams = container.querySelectorAll('.param-item');
            const newIndex = existingParams.length;
            const newParam = { name: '', description: '', required: false, defaultValue: '', validValues: [] };
            renderQueryParam(container, apiKey, newParam, newIndex);
        }

        function removeQueryParam(button) {
            const paramItem = button.closest('.param-item');
            if (paramItem) { paramItem.remove(); }
        }

        function addApiEndpoint() {
             const newApiKey = \`new_endpoint_\${Date.now()}\`;
             const newConfigEntry = { group: "未分组", description: "", url: "", method: "redirect", queryParams: [], proxySettings: {} };
             if (!apiConfigsContainer.querySelector('.card')) {
                 apiConfigsContainer.innerHTML = '';
             }
             // Find or create the '未分组' section
             let ungroupedContainer = apiConfigsContainer.querySelector('#group-未分组');
             if (!ungroupedContainer) {
                 const groupTitle = document.createElement('h2');
                 groupTitle.className = 'group-title';
                 groupTitle.textContent = '未分组';
                 apiConfigsContainer.appendChild(groupTitle);
                 ungroupedContainer = document.createElement('div');
                 ungroupedContainer.id = 'group-未分组'; // Assign ID to the container
                 apiConfigsContainer.appendChild(ungroupedContainer);
             }
             const cardElement = renderApiEndpoint(newApiKey, newConfigEntry);
             ungroupedContainer.appendChild(cardElement);

             cardElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
             cardElement.querySelector('.api-key-input').focus();
        }

        function removeApiEndpoint(card) {
            const apiKeyInput = card.querySelector('.api-key-input');
            const keyToRemove = apiKeyInput ? apiKeyInput.value : '(未知)';
            if (confirm(\`确定要删除端点 "\${keyToRemove}" 吗？此操作将在保存后生效且无法撤销。\`)) {
                const parentGroupContainer = card.parentElement;
                card.remove();
                 if (!apiConfigsContainer.querySelector('.card')) {
                     apiConfigsContainer.innerHTML = '<div class="alert alert-info">当前没有配置任何 API 端点。点击“添加新 API 端点”开始。</div>';
                 } else if (parentGroupContainer && !parentGroupContainer.querySelector('.card')) {
                      const groupTitle = parentGroupContainer.previousElementSibling;
                      if (groupTitle && groupTitle.classList.contains('group-title')) {
                          groupTitle.remove();
                      }
                      parentGroupContainer.remove();
                 }
                showMessage(\`端点 \${keyToRemove} 已标记为删除。点击“保存所有配置”以确认。\`, 'success');
            }
        }

        async function loadConfig() {
            apiConfigsContainer.innerHTML = \`<div class="text-center"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">正在加载配置...</span></div><p class="mt-2">正在加载配置...</p></div>\`;
            try {
                const response = await fetch('/config');
                if (!response.ok) throw new Error(\`HTTP error! status: \${response.status}\`);
                currentConfigData = await response.json();
                if (!currentConfigData.apiUrls) currentConfigData.apiUrls = {};
                renderConfig();
            } catch (error) {
                console.error('Error loading config:', error);
                apiConfigsContainer.innerHTML = '<div class="alert alert-danger">加载配置失败。</div>';
                showMessage('加载配置失败: ' + error.message, 'error');
            }
        }

        async function saveConfig(event) {
            event.preventDefault();

            const updatedApiUrls = {};
            const cards = apiConfigsContainer.querySelectorAll('.card[data-api-key]');
            let hasError = false;
            const usedApiKeys = new Set();

            cards.forEach(card => {
                 if (hasError) return;
                const apiKeyInput = card.querySelector('.api-key-input');
                const apiKey = sanitizeApiKey(apiKeyInput.value.trim());
                const originalApiKey = card.getAttribute('data-api-key');

                 if (!apiKey) { showMessage(\`错误：发现一个未命名（为空）的 API 端点！请输入路径名。\`, 'error'); apiKeyInput.focus(); hasError = true; return; }
                 if (usedApiKeys.has(apiKey)) { showMessage(\`错误：API 端点路径 "/\${apiKey}" 重复！请确保每个端点路径唯一。\`, 'error'); apiKeyInput.focus(); hasError = true; return; }
                 usedApiKeys.add(apiKey);

                const urlInput = card.querySelector(\`#\${originalApiKey}-url\`);
                const configEntry = {
                    group: card.querySelector(\`#\${originalApiKey}-group\`).value.trim() || '未分组',
                    description: card.querySelector(\`#\${originalApiKey}-description\`).value.trim(),
                    url: urlInput.value.trim(),
                    method: card.querySelector(\`#\${originalApiKey}-method\`).value,
                    queryParams: [],
                    proxySettings: {}
                };

                if (!configEntry.url) { showMessage(\`错误：端点 /\${apiKey} 的目标 URL 不能为空！\`, 'error'); urlInput.focus(); hasError = true; return; }

                // Collect Query Params... (same as before)
                const paramItems = card.querySelectorAll(\`#\${originalApiKey}-params-list .param-item\`);
                const paramNames = new Set();
                paramItems.forEach((paramItem) => {
                     if (hasError) return;
                     const nameInput = paramItem.querySelector(\`input[id$="-name"]\`);
                     const paramName = nameInput.value.trim();
                     if (!paramName) return;
                     if (paramNames.has(paramName)) { showMessage(\`错误：端点 /\${apiKey} 存在重复的查询参数名称 "\${paramName}"！\`, 'error'); nameInput.focus(); hasError = true; return; }
                     paramNames.add(paramName);
                     const descInput = paramItem.querySelector(\`textarea[id$="-desc"]\`);
                     const requiredInput = paramItem.querySelector(\`input[id$="-required"]\`);
                     const defaultInput = paramItem.querySelector(\`input[id$="-default"]\`);
                     const validValuesInput = paramItem.querySelector(\`input[id$="-validValues"]\`);
                     const validValuesString = validValuesInput.value.trim();
                     configEntry.queryParams.push({
                         name: paramName, description: descInput.value.trim(), required: requiredInput.checked,
                         defaultValue: defaultInput.value.trim() || undefined,
                         validValues: validValuesString ? validValuesString.split(',').map(s => s.trim()).filter(Boolean) : undefined
                     });
                });
                 if (hasError) return;


                // Collect Proxy Settings... (same as before)
                if (configEntry.method === 'proxy') {
                    const imageUrlFieldInput = card.querySelector(\`#\${originalApiKey}-imageUrlField\`);
                    const fallbackActionSelect = card.querySelector(\`#\${originalApiKey}-fallbackAction\`);
                    const originalConfigEntry = currentConfigData.apiUrls[originalApiKey];
                    if (apiKey === 'forward' && originalConfigEntry?.proxySettings?.imageUrlFieldFromParam) {
                         configEntry.proxySettings.imageUrlFieldFromParam = originalConfigEntry.proxySettings.imageUrlFieldFromParam;
                    } else if (imageUrlFieldInput) {
                         configEntry.proxySettings.imageUrlField = imageUrlFieldInput.value.trim() || undefined;
                    }
                    configEntry.proxySettings.fallbackAction = fallbackActionSelect?.value || 'returnJson';
                }

                 const originalConfig = currentConfigData.apiUrls[originalApiKey];
                 if (originalConfig?.urlConstruction) { configEntry.urlConstruction = originalConfig.urlConstruction; }
                 if (originalConfig?.modelName) { configEntry.modelName = originalConfig.modelName; }

                updatedApiUrls[apiKey] = configEntry;
            });

            if (hasError) { console.error("Validation errors found. Aborting save."); return; }

            // Find the potentially moved baseTag input
            const currentBaseTagInput = document.getElementById('baseTag');
            const updatedConfig = {
                apiUrls: updatedApiUrls,
                baseTag: currentBaseTagInput ? currentBaseTagInput.value.trim() : '' // Get value from current location
            };
            console.log("Saving config:", JSON.stringify(updatedConfig, null, 2));

            const saveButton = form.querySelector('.save-button');
            saveButton.disabled = true;
            saveButton.innerHTML = \`<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 保存中...\`;

            try {
                const response = await fetch('/config', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updatedConfig),
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || \`HTTP error! status: \${response.status}\`);
                showMessage(result.message || '配置已成功更新！所有更改已动态生效。', 'success');
                await loadConfig();
            } catch (error) {
                console.error('Error saving config:', error);
                showMessage('保存配置失败: ' + error.message, 'error');
            } finally {
                 saveButton.disabled = false;
                 saveButton.innerHTML = \`<i class="bi bi-save"></i> 保存所有配置\`;
            }
        }

        form.addEventListener('submit', saveConfig);
        document.addEventListener('DOMContentLoaded', loadConfig);
    </script>
</body>
</html>
`;
    res.setHeader('Content-Type', 'text/html');
    res.send(adminHtmlContent);
});


// --- Server Start ---
// 确保在服务器启动前先加载配置
(async () => {
    try {
        console.log('Loading configuration before starting server...');
        await loadConfig();
        console.log('Configuration loaded successfully.');
        
        // 启动服务器
        app.listen(PORT, () => {
            console.log(`API Forwarder running on http://localhost:${PORT}`);
            console.log(`Admin interface available at http://localhost:${PORT}/admin`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
})();

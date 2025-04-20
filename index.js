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

// --- 管理界面鉴权配置 ---
// 从环境变量中读取管理员token，如果不存在则使用默认值“admin”
const adminToken = process.env.ADMIN_TOKEN || 'admin';
// 管理界面的cookie名称
const adminCookieName = 'api_forward_admin_token';

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
// 添加cookie解析中间件
app.use(require('cookie-parser')());
// Serve static files like config.json (for loading in admin page)
// We will handle admin.html explicitly below.
app.use(express.static(path.join(__dirname)));

// --- Configuration Management API ---
app.get('/config', checkAdminAuth, (req, res) => {
    // Send the current in-memory config
    res.json(currentConfig);
});

app.post('/config', checkAdminAuth, async (req, res) => {
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
    
    // 为 LLM 提示词准备数据
    const baseURL = `${req.protocol}://${req.get('host')}`;
    const pathFunctions = [];
    
    // 按组排序的顺序
    const groupOrder = {'AI绘图': 1, '二次元图片': 2, '三次元图片': 3, '表情包': 4, '未分组': 99};
    
    // 准备所有 API 配置
    const allApis = [];
    for (const key in currentConfig.apiUrls) {
        allApis.push({ key, ...currentConfig.apiUrls[key] });
    }
    
    // 按组和名称排序
    allApis.sort((a, b) => {
        const orderA = groupOrder[a.group || '未分组'] || 50;
        const orderB = groupOrder[b.group || '未分组'] || 50;
        return orderA - orderB || a.key.localeCompare(b.key);
    });
    
    // 生成路径功能描述
    allApis.forEach(entry => {
        const key = entry.key;
        const group = entry.group || '未分组';
        const description = entry.description || group;
        
        // 格式化路径描述
        let pathDesc = '';
        
        // AI绘图类型需要特殊处理tags参数
        if (group === 'AI绘图') {
            pathDesc = `${description}:/${key}?tags=<tags>`;
        } 
        // 其他类型直接使用路径
        else {
            pathDesc = `${description}:/${key}`;
        }
        
        pathFunctions.push(pathDesc);
    });
    
    // 生成完整提示词，适合嵌入到 YAML 文件中，每行都有缩进
    const llmPrompt = `    picture_url: |
    {{ 
    根据用户请求，选择合适的图片API路径，生成并返回完整URL。仅输出最终URL，不要添加其他文字。
    基础URL：${baseURL}
    可用路径（不要修改路径格式）：
${pathFunctions.map(path => `    - ${path}`).join('\n')}
    特殊说明：
    1. AI绘图路径(/flux, /turbo)需要tags参数
    2. 生成tags时，将用户描述转化为50个左右的关键词，用英文逗号分隔
    3. 所有参数必须进行URL编码
    4. 严禁生成色情内容
    示例：如果用户请求“给我一张山水画”，应返回：${baseURL}/flux?tags=mountains%2Cwater%2Clandscape%2Ctraditional%2Cchinese%2Cpainting%2Cscenery}}`;
    

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
    <!-- Pinyin Library for Emoticon Fetching (using unpkg) -->
    <script src="https://unpkg.com/pinyin-pro@3.26.0/dist/index.js"></script> 
    <style>
        /* v0 Style Adjustments */
        :root {
            --v0-background: #ffffff; /* White background */
            --v0-foreground: #111827; /* Darker gray text (Tailwind gray-900) */
            --v0-muted: #f9fafb; /* Lighter gray for muted backgrounds (Tailwind gray-50) */
            --v0-muted-foreground: #6b7280; /* Medium gray for muted text (Tailwind gray-500) */
            --v0-border: #e5e7eb; /* Light gray border (Tailwind gray-200) */
            --v0-input: #d1d5db; /* Input border (Tailwind gray-300) */
            --v0-primary: #111827; /* Primary color (button bg) - Dark gray */
            --v0-primary-foreground: #ffffff; /* Text on primary button - White */
            --v0-secondary: #f3f4f6; /* Secondary button bg (Tailwind gray-100) */
            --v0-secondary-foreground: #1f2937; /* Text on secondary button (Tailwind gray-800) */
            --v0-card: #ffffff; /* Card background */
            --v0-card-foreground: #111827; /* Card text */
            --v0-radius: 0.5rem; /* Default border radius */
            --v0-radius-lg: 0.75rem; /* Larger radius */
            --v0-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06); /* Subtle shadow */
        }
        body { 
            padding-top: 2rem; 
            padding-bottom: 4rem; 
            background-color: var(--v0-muted); /* Use muted for page background */
            color: var(--v0-foreground);
            font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"; /* Tailwind default font stack */
        }
        .container { max-width: 1140px; }
        
        /* Card Styles */
        .card { 
            background-color: var(--v0-card);
            color: var(--v0-card-foreground);
            border: 1px solid var(--v0-border); 
            border-radius: var(--v0-radius-lg); /* Larger radius */
            box-shadow: var(--v0-shadow); /* Use shadow variable */
            margin-bottom: 1.5rem;
        }
        .card-header {
            background-color: var(--v0-card); 
            border-bottom: 1px solid var(--v0-border);
            padding: 1rem 1.5rem; /* Increased padding */
            font-weight: 600; /* Bolder header */
            border-radius: var(--v0-radius-lg) var(--v0-radius-lg) 0 0; /* Match card radius */
        }
        .card-body { padding: 1.5rem; }
        .card-footer { 
            background-color: var(--v0-muted); 
            border-top: 1px solid var(--v0-border);
            color: var(--v0-muted-foreground);
            padding: 0.75rem 1.5rem; /* Match header padding */
            border-radius: 0 0 var(--v0-radius-lg) var(--v0-radius-lg); /* Match card radius */
        }
        .card img { 
            max-height: 180px; /* Slightly smaller max height */
            object-fit: contain; 
            border-radius: calc(var(--v0-radius-lg) - 1px) calc(var(--v0-radius-lg) - 1px) 0 0; /* Match card radius */
        }
        
        /* Button Styles */
        .btn {
             border-radius: var(--v0-radius);
             padding: 0.5rem 1rem; /* Slightly smaller padding */
             font-size: 0.875rem; /* Smaller font size */
             font-weight: 500;
             transition: background-color 0.15s ease-in-out, border-color 0.15s ease-in-out, color 0.15s ease-in-out, box-shadow 0.15s ease-in-out;
             border: 1px solid transparent; /* Ensure border exists for consistent sizing */
             line-height: 1.25rem; /* Ensure consistent height */
        }
        .btn:focus-visible { /* Modern focus ring */
             outline: 2px solid transparent;
             outline-offset: 2px;
             box-shadow: 0 0 0 2px var(--v0-background), 0 0 0 4px var(--v0-primary);
        }
        .btn-primary {
            background-color: var(--v0-primary);
            border-color: var(--v0-primary);
            color: var(--v0-primary-foreground);
        }
        .btn-primary:hover {
            background-color: #374151; /* Tailwind gray-700 */
            border-color: #374151;
            color: var(--v0-primary-foreground);
        }
        .btn-outline-primary {
             color: var(--v0-primary);
             border-color: var(--v0-input); /* Use input border color */
             background-color: var(--v0-background);
        }
         .btn-outline-primary:hover {
             background-color: var(--v0-secondary);
             color: var(--v0-secondary-foreground);
             border-color: var(--v0-input);
         }
         .btn-success { /* For copy button success state */
             background-color: #22c55e; /* Tailwind green-500 */
             border-color: #22c55e;
             color: #ffffff;
         }
         .btn-success:hover {
             background-color: #16a34a; /* Tailwind green-600 */
             border-color: #16a34a;
             color: #ffffff;
         }
        .btn-lg { padding: 0.75rem 1.5rem; font-size: 1rem; }
        .btn-sm { padding: 0.25rem 0.75rem; font-size: 0.75rem; border-radius: calc(var(--v0-radius) - 0.125rem); }

        /* Table Styles */
        .table { 
            border-color: var(--v0-border); 
            margin-bottom: 0; 
        }
        .table th, .table td { 
            vertical-align: middle; 
            padding: 0.75rem 1rem; /* Adjusted padding */
            border-top: 1px solid var(--v0-border);
            font-size: 0.875rem; /* Smaller font */
            line-height: 1.25rem;
        }
        .table thead th {
            border-bottom: 1px solid var(--v0-border); /* Standard border */
            background-color: var(--v0-muted); 
            color: var(--v0-muted-foreground); /* Muted text for header */
            font-weight: 500;
            text-transform: uppercase; /* Uppercase headers */
            letter-spacing: 0.05em; /* Slight letter spacing */
            font-size: 0.75rem; /* Smaller header font */
        }
        .table-striped > tbody > tr:nth-of-type(odd) > * {
             background-color: var(--v0-muted); /* Use muted for striping */
             color: var(--v0-foreground);
        }
        .table-hover > tbody > tr:hover > * {
             background-color: #f3f4f6; /* Tailwind gray-100 */
             color: var(--v0-foreground);
        }
        .table-bordered { border: 1px solid var(--v0-border); }
        .table-bordered th, .table-bordered td { border: 1px solid var(--v0-border); }
        .table-responsive { margin-bottom: 1rem; border: 1px solid var(--v0-border); border-radius: var(--v0-radius); overflow: hidden; } /* Add border/radius to responsive container */

        /* Code & Pre Styles */
        code { 
            font-size: 0.875em; 
            color: var(--v0-foreground); 
            background-color: var(--v0-secondary); /* Use secondary bg */
            padding: 0.2em 0.4em;
            border-radius: 0.25rem; /* Slightly smaller radius */
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; /* Monospace font */
        }
        pre {
            background-color: var(--v0-secondary); /* Use secondary bg */
            border: 1px solid var(--v0-border);
            border-radius: var(--v0-radius);
            padding: 1rem;
            color: var(--v0-foreground);
            white-space: pre-wrap; 
            word-break: break-word; 
            font-size: 0.875rem;
            line-height: 1.5;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; /* Monospace font */
        }
        
        /* Alert Styles */
        .alert {
             border-radius: var(--v0-radius);
             border: 1px solid transparent;
             padding: 0.75rem 1rem; /* Adjusted padding */
             font-size: 0.875rem;
        }
        .alert-info {
             color: #0c5460; /* Keep original colors for now */
             background-color: #d1ecf1;
             border-color: #bee5eb;
        }
        .alert-info .bi { 
             margin-right: 0.5rem;
             vertical-align: text-bottom; /* Align icon better */
        }

        /* Other Styles */
        .p-5 { padding: 3rem !important; } /* Increased padding */
        .py-5 { padding-top: 3rem !important; padding-bottom: 3rem !important; }
        .mb-4 { margin-bottom: 1.5rem !important; }
        .mt-4 { margin-top: 1.5rem !important; }
        .mt-3 { margin-top: 1rem !important; }
        .mt-2 { margin-top: 0.5rem !important; }
        .bg-light { background-color: var(--v0-card) !important; border: 1px solid var(--v0-border); } /* Use card bg and add border */
        .rounded-3 { border-radius: var(--v0-radius-lg) !important; } /* Use large radius */
        .text-muted { color: var(--v0-muted-foreground) !important; }
        .fw-bold { font-weight: 600 !important; } 
        .display-5 { font-size: 2.25rem; font-weight: 700; } /* Slightly smaller, bolder */
        .fs-4 { font-size: 1.125rem; line-height: 1.75rem; } /* Adjusted size and line height */
        h1, h2, h3, h5 { font-weight: 600; color: var(--v0-foreground); }
        h2.h5 { font-size: 1rem; font-weight: 600; } /* Adjust size for card headers */
        hr.my-1 { margin-top: 0.25rem !important; margin-bottom: 0.25rem !important; opacity: 0.1;}
        .badge { border-radius: 0.375rem; padding: 0.25em 0.6em; font-weight: 500; font-size: 0.75rem; } /* Smaller badge */
        .bg-primary { background-color: var(--v0-primary) !important; color: var(--v0-primary-foreground); }
        .bg-secondary { background-color: var(--v0-secondary) !important; color: var(--v0-secondary-foreground); }
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
        
        <!-- LLM 提示词生成卡片 -->
        <div class="card mb-4">
            <div class="card-header d-flex justify-content-between align-items-center">
                <h2 class="h5 mb-0">LLM 提示词</h2>
                <button id="copy-prompt-btn" class="btn btn-sm btn-outline-primary"><i class="bi bi-clipboard"></i> 复制</button>
            </div>
            <div class="card-body">
                <div class="alert alert-info mb-2">
                    <small><i class="bi bi-info-circle"></i> 以下是自动生成的 LLM 提示词，适合嵌入到 YAML 文件中。每行都有适当的缩进，复制后可直接粘贴到配置文件中。</small>
                </div>
                <pre id="llm-prompt" class="bg-light p-3 rounded" style="white-space: pre-wrap; word-break: break-word; font-size: 0.875rem;">${llmPrompt}</pre>
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
    
    <!-- 复制按钮脚本 -->
    <script>
        document.addEventListener('DOMContentLoaded', function() {
            const promptElement = document.getElementById('llm-prompt');
            const copyButton = document.getElementById('copy-prompt-btn');
            
            if (promptElement && copyButton) {
                // 复制按钮功能
                copyButton.addEventListener('click', () => {
                    const textToCopy = promptElement.textContent;
                    navigator.clipboard.writeText(textToCopy).then(() => {
                        // 显示复制成功提示
                        const originalText = copyButton.innerHTML;
                        copyButton.innerHTML = '<i class="bi bi-check"></i> 已复制';
                        copyButton.classList.remove('btn-outline-primary');
                        copyButton.classList.add('btn-success');
                        
                        setTimeout(() => {
                            copyButton.innerHTML = originalText;
                            copyButton.classList.remove('btn-success');
                            copyButton.classList.add('btn-outline-primary');
                        }, 2000);
                    }).catch(err => {
                        console.error('复制失败:', err);
                        alert('复制失败，请手动复制');
                    });
                });
            }
        });
    </script>
</body>
</html>
`;
    res.setHeader('Content-Type', 'text/html');
    res.send(homeHtmlContent);
});

// --- Admin Interface Routes ---
// 验证管理员权限的中间件
function checkAdminAuth(req, res, next) {
    // 检查cookie中的token
    const tokenFromCookie = req.cookies?.[adminCookieName];
    
    // 如果有效token，允许访问
    if (tokenFromCookie === adminToken) {
        return next();
    }
    
    // 如果是API请求，返回401状态码
    if (req.path.startsWith('/config') || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // 否则重定向到登录页面
    res.redirect('/admin-login');
}

// 登录页面
app.get('/admin-login', (req, res) => {
    console.log("[Router] Handling request for /admin-login");
    const loginHtmlContent = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API 转发管理登录</title>
    <link rel="stylesheet" href="https://lf26-cdn-tos.bytecdntp.com/cdn/expire-1-M/twitter-bootstrap/5.1.3/css/bootstrap.min.css">
    <style>
        /* v0 Style Adjustments */
        :root {
            --v0-background: #ffffff; /* White background */
            --v0-foreground: #09090b; /* Near black text */
            --v0-muted: #f9fafb; /* Lighter gray (Tailwind gray-50) */
            --v0-muted-foreground: #6b7280; /* Medium gray (Tailwind gray-500) */
            --v0-border: #e5e7eb; /* Light gray border (Tailwind gray-200) */
            --v0-input: #d1d5db; /* Input border (Tailwind gray-300) */
            --v0-primary: #111827; /* Dark gray (Tailwind gray-900) */
            --v0-primary-foreground: #ffffff; /* White */
            --v0-destructive: #ef4444; /* Red (Tailwind red-500) */
            --v0-destructive-foreground: #ffffff; /* White */
            --v0-card: #ffffff; /* Card background */
            --v0-card-foreground: #111827; /* Card text */
            --v0-radius: 0.5rem; /* Default border radius */
            --v0-radius-lg: 0.75rem; /* Larger radius */
            --v0-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06); /* Subtle shadow */
        }
        body { 
            background-color: var(--v0-muted); 
            height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"; /* Tailwind default font stack */
            color: var(--v0-foreground);
        }
        .login-container {
            max-width: 400px;
            width: 100%;
            padding: 2.5rem; 
            background-color: var(--v0-card);
            border-radius: var(--v0-radius-lg); /* Larger radius */
            border: 1px solid var(--v0-border);
            box-shadow: var(--v0-shadow); /* Use shadow variable */
        }
        .login-header {
            text-align: center;
            margin-bottom: 2rem;
        }
        .login-header h2 {
            font-size: 1.5rem; /* Slightly smaller heading */
            font-weight: 600;
            color: var(--v0-foreground);
            margin-bottom: 0.5rem;
        }
        .login-header p {
            color: var(--v0-muted-foreground);
            font-size: 0.875rem; /* Smaller text */
        }
        .error-message {
            color: var(--v0-destructive); 
            background-color: #fef2f2; /* Tailwind red-50 */
            border: 1px solid #fca5a5; /* Tailwind red-300 */
            border-radius: var(--v0-radius); /* Standard radius */
            padding: 0.75rem 1rem;
            margin-bottom: 1.5rem;
            font-size: 0.875rem;
            display: none; 
        }
        .form-label {
            font-weight: 500;
            margin-bottom: 0.5rem;
            font-size: 0.875rem;
            color: var(--v0-foreground);
        }
        .form-control {
            display: block;
            width: 100%;
            padding: 0.5rem 0.75rem; /* Adjusted padding */
            font-size: 0.875rem; /* Smaller font */
            font-weight: 400;
            line-height: 1.5;
            color: var(--v0-foreground);
            background-color: var(--v0-background);
            background-clip: padding-box;
            border: 1px solid var(--v0-input);
            appearance: none;
            border-radius: var(--v0-radius);
            transition: border-color .15s ease-in-out,box-shadow .15s ease-in-out;
        }
        .form-control:focus {
            color: var(--v0-foreground);
            background-color: var(--v0-background);
            border-color: var(--v0-primary); 
            outline: 0;
            box-shadow: 0 0 0 2px var(--v0-background), 0 0 0 4px var(--v0-primary); /* Modern focus ring */
        }
        .btn {
             border-radius: var(--v0-radius);
             padding: 0.5rem 1rem; /* Adjusted padding */
             font-size: 0.875rem; /* Smaller font */
             font-weight: 500;
             transition: background-color 0.15s ease-in-out, border-color 0.15s ease-in-out, color 0.15s ease-in-out, box-shadow 0.15s ease-in-out;
             display: inline-flex; 
             align-items: center;
             justify-content: center;
             line-height: 1.25rem; /* Consistent height */
             border: 1px solid transparent;
        }
         .btn:focus-visible { /* Modern focus ring */
             outline: 2px solid transparent;
             outline-offset: 2px;
             box-shadow: 0 0 0 2px var(--v0-background), 0 0 0 4px var(--v0-primary);
        }
        .btn-primary {
            background-color: var(--v0-primary);
            border-color: var(--v0-primary);
            color: var(--v0-primary-foreground);
        }
        .btn-primary:hover {
            background-color: #374151; /* Tailwind gray-700 */
            border-color: #374151;
            color: var(--v0-primary-foreground);
        }
        .w-100 { width: 100% !important; }
        .mb-3 { margin-bottom: 1rem !important; } /* Reduced margin */
    </style>
</head>
<body>
    <div class="login-container">
        <div class="login-header">
            <h2>API 转发管理登录</h2>
            <p class="text-muted">请输入管理员令牌进行登录</p>
        </div>
        <div id="error-message" class="error-message"></div>
        <form id="login-form">
            <div class="mb-3">
                <label for="token" class="form-label">管理令牌</label>
                <input type="password" class="form-control" id="token" required>
            </div>
            <button type="submit" class="btn btn-primary w-100">登录</button>
        </form>
    </div>

    <script>
        const form = document.getElementById('login-form');
        const errorMessage = document.getElementById('error-message');
        
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const token = document.getElementById('token').value;
            
            try {
                const response = await fetch('/admin-auth', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ token })
                });
                
                if (response.ok) {
                    // 登录成功，重定向到管理页面
                    window.location.href = '/admin';
                } else {
                    // 显示错误信息
                    const data = await response.json();
                    errorMessage.textContent = data.error || '登录失败，请检查令牌是否正确';
                    errorMessage.style.display = 'block';
                }
            } catch (error) {
                errorMessage.textContent = '登录请求失败，请重试';
                errorMessage.style.display = 'block';
                console.error('Login error:', error);
            }
        });
    </script>
</body>
</html>
    `;
    res.setHeader('Content-Type', 'text/html');
    res.send(loginHtmlContent);
});

// 处理登录请求
app.post('/admin-auth', express.json(), (req, res) => {
    const { token } = req.body;
    
    if (token === adminToken) {
        // 设置cookie，有效期24小时
        res.cookie(adminCookieName, token, { 
            maxAge: 24 * 60 * 60 * 1000, // 24小时
            httpOnly: true,
            sameSite: 'strict'
        });
        res.json({ success: true });
    } else {
        res.status(401).json({ error: '无效的管理令牌' });
    }
});

// 管理员退出
app.get('/admin-logout', (req, res) => {
    res.clearCookie(adminCookieName);
    res.redirect('/admin-login');
});

// 管理界面（需要验证）
app.get('/admin', checkAdminAuth, (req, res) => {
    console.log("[Router] Handling request for /admin (Admin Interface)");
    const adminHtmlContent = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API 转发配置管理</title>
    <!-- 新 Bootstrap5 核心 CSS 文件 -->
    <link rel="stylesheet" href="https://lf26-cdn-tos.bytecdntp.com/cdn/expire-1-M/twitter-bootstrap/5.1.3/css/bootstrap.min.css">
    <!-- Optional: Bootstrap Icons CDN (using cdnjs) -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap-icons/1.11.3/font/bootstrap-icons.min.css">
    <!-- Pinyin Library for Emoticon Fetching (using unpkg) -->
    <script src="https://unpkg.com/pinyin-pro@3.26.0/dist/index.js"></script>
    <style>
        /* v0 Style Adjustments */
        :root {
            --v0-background: #ffffff; /* White background */
            --v0-foreground: #09090b; /* Near black text */
            --v0-muted: #f9fafb; /* Lighter gray (Tailwind gray-50) */
            --v0-muted-foreground: #6b7280; /* Medium gray (Tailwind gray-500) */
            --v0-border: #e5e7eb; /* Light gray border (Tailwind gray-200) */
            --v0-input: #d1d5db; /* Input border (Tailwind gray-300) */
            --v0-primary: #111827; /* Dark gray (Tailwind gray-900) */
            --v0-primary-foreground: #ffffff; /* White */
            --v0-secondary: #f3f4f6; /* Secondary button bg (Tailwind gray-100) */
            --v0-secondary-foreground: #1f2937; /* Text on secondary button (Tailwind gray-800) */
            --v0-destructive: #ef4444; /* Red (Tailwind red-500) */
            --v0-destructive-foreground: #ffffff; /* White */
            --v0-success: #22c55e; /* Green (Tailwind green-500) */
            --v0-success-foreground: #ffffff; /* White */
            --v0-card: #ffffff; /* Card background */
            --v0-card-foreground: #111827; /* Card text */
            --v0-radius: 0.5rem; /* Default border radius */
            --v0-radius-sm: 0.375rem; /* Smaller radius */
            --v0-radius-lg: 0.75rem; /* Larger radius */
            --v0-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06); /* Subtle shadow */
        }
        body { 
            background-color: var(--v0-muted); 
            padding-top: 2rem; 
            padding-bottom: 4rem; 
            font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"; /* Tailwind default font stack */
            color: var(--v0-foreground);
        }
        .container { max-width: 960px; }
        
        /* Card Styles */
        .card { 
            background-color: var(--v0-card);
            color: var(--v0-card-foreground);
            border: 1px solid var(--v0-border); 
            border-radius: var(--v0-radius-lg); 
            box-shadow: var(--v0-shadow); /* Use shadow variable */
            margin-bottom: 1.5rem; 
        }
        .card-header { 
            background-color: var(--v0-card); 
            border-bottom: 1px solid var(--v0-border);
            padding: 1rem 1.5rem; 
            font-weight: 600; 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
            border-radius: var(--v0-radius-lg) var(--v0-radius-lg) 0 0; 
        }
        .card-body { padding: 1.5rem; }

        /* API Key Input in Header */
        .api-key-input { 
            font-weight: 600; 
            border: none; 
            border-bottom: 1px solid var(--v0-input); /* Use input border color */
            padding: 0.25rem 0.5rem; 
            background: transparent; 
            color: var(--v0-primary); 
            margin-left: 0.5rem; 
            width: auto; 
            max-width: 250px; 
            border-radius: 0; 
            transition: border-color 0.15s ease-in-out, box-shadow 0.15s ease-in-out;
            font-size: 1rem; /* Match header font size */
        }
        .api-key-input:focus { 
            outline: none; 
            border-bottom-color: var(--v0-primary); 
            box-shadow: 0 1px 0 0 var(--v0-primary); /* Subtle bottom focus shadow */
        }
        
        /* Form Elements */
        .form-label {
            font-weight: 500;
            font-size: 0.875rem;
            color: var(--v0-foreground);
            margin-bottom: 0.375rem; /* Adjusted margin */
        }
        .col-form-label { padding-top: calc(0.5rem + 1px); padding-bottom: calc(0.5rem + 1px); font-size: 0.875rem; } 
        .form-control, .form-select {
            display: block;
            width: 100%;
            padding: 0.5rem 0.75rem; 
            font-size: 0.875rem; 
            font-weight: 400;
            line-height: 1.25rem; /* Consistent line height */
            color: var(--v0-foreground);
            background-color: var(--v0-background);
            background-clip: padding-box;
            border: 1px solid var(--v0-input);
            appearance: none;
            border-radius: var(--v0-radius); 
            transition: border-color .15s ease-in-out,box-shadow .15s ease-in-out;
        }
        textarea.form-control { min-height: calc(1.25rem * 3 + 1rem + 2px); } /* Adjust based on line height */
        .form-control:focus, .form-select:focus {
            color: var(--v0-foreground);
            background-color: var(--v0-background);
            border-color: var(--v0-primary);
            outline: 0;
            box-shadow: 0 0 0 2px var(--v0-background), 0 0 0 4px var(--v0-primary); /* Modern focus ring */
        }
        .form-control[readonly] {
             background-color: var(--v0-muted);
             opacity: 0.7; /* Slightly faded */
             cursor: not-allowed;
        }
        .form-check-input {
             width: 1em; /* Standard size */
             height: 1em;
             margin-top: 0.25em; /* Adjust alignment */
             border-radius: 0.25em;
             border: 1px solid var(--v0-input);
        }
        .form-check-input:focus {
             border-color: var(--v0-primary);
             outline: 0;
             box-shadow: 0 0 0 2px var(--v0-background), 0 0 0 4px var(--v0-primary);
        }
        .form-check-input:checked {
             background-color: var(--v0-primary);
             border-color: var(--v0-primary);
        }
        .form-switch .form-check-input {
             width: 2em; /* Standard switch width */
             margin-left: -2.5em;
             background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='-4 -4 8 8'%3e%3ccircle r='3' fill='rgba(107, 114, 128, 0.25)'/%3e%3c/svg%3e"); /* Gray-500 at 25% opacity */
             background-position: left center;
             border-radius: 2em;
             transition: background-position .15s ease-in-out;
        }
        .form-switch .form-check-input:focus {
             background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='-4 -4 8 8'%3e%3ccircle r='3' fill='rgba(107, 114, 128, 0.25)'/%3e%3c/svg%3e");
        }
        .form-switch .form-check-input:checked {
             background-position: right center;
             background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='-4 -4 8 8'%3e%3ccircle r='3' fill='%23fff'/%3e%3c/svg%3e"); 
        }
        .form-check-label { font-size: 0.875rem; padding-left: 0.5em; } /* Add padding for switch */
        
        /* Buttons */
        .btn {
             border-radius: var(--v0-radius);
             padding: 0.5rem 1rem; 
             font-size: 0.875rem;
             font-weight: 500;
             transition: background-color 0.15s ease-in-out, border-color 0.15s ease-in-out, color 0.15s ease-in-out, opacity 0.15s ease-in-out, box-shadow 0.15s ease-in-out;
             display: inline-flex;
             align-items: center;
             justify-content: center;
             gap: 0.375rem; /* Reduced gap */
             line-height: 1.25rem; /* Consistent height */
             border: 1px solid transparent;
        }
         .btn:focus-visible { /* Modern focus ring */
             outline: 2px solid transparent;
             outline-offset: 2px;
             box-shadow: 0 0 0 2px var(--v0-background), 0 0 0 4px var(--v0-primary);
        }
        .btn-primary {
            background-color: var(--v0-primary); border-color: var(--v0-primary); color: var(--v0-primary-foreground);
        }
        .btn-primary:hover { background-color: #374151; border-color: #374151; color: var(--v0-primary-foreground); } /* Tailwind gray-700 */
        .btn-primary:disabled { background-color: var(--v0-primary); border-color: var(--v0-primary); color: var(--v0-primary-foreground); opacity: 0.5; cursor: not-allowed; }
        
        .btn-success { 
            background-color: var(--v0-success); border-color: var(--v0-success); color: var(--v0-success-foreground);
        }
        .btn-success:hover { background-color: #16a34a; border-color: #16a34a; } /* Tailwind green-600 */
        
        .btn-danger { 
            background-color: var(--v0-destructive); border-color: var(--v0-destructive); color: var(--v0-destructive-foreground);
        }
        .btn-danger:hover { background-color: #dc2626; border-color: #dc2626; } /* Tailwind red-600 */
        
        .btn-outline-secondary { 
             color: var(--v0-secondary-foreground);
             border-color: var(--v0-input);
             background-color: var(--v0-background);
        }
         .btn-outline-secondary:hover {
             background-color: var(--v0-secondary);
             border-color: var(--v0-input);
             color: var(--v0-secondary-foreground);
         }
        
        .btn-sm { padding: 0.25rem 0.75rem; font-size: 0.75rem; border-radius: var(--v0-radius-sm); gap: 0.25rem; }
        .btn-lg { padding: 0.625rem 1.25rem; font-size: 1rem; } /* Adjusted large button */
        .save-button .spinner-border { width: 1em; height: 1em; border-width: .15em; } /* Thinner spinner */

        /* Specific Sections */
        .proxy-settings, .query-params { 
            margin-top: 1.5rem; 
            padding-top: 1.5rem; 
            border-top: 1px solid var(--v0-border); 
        }
        .proxy-settings h5, .query-params h5 {
             font-size: 0.875rem; /* Smaller heading */
             font-weight: 600;
             margin-bottom: 1rem;
             color: var(--v0-foreground);
             text-transform: uppercase; /* Uppercase subheadings */
             letter-spacing: 0.05em;
        }
        .param-item { 
            border: 1px solid var(--v0-border); 
            padding: 1rem; 
            margin-bottom: 1rem; 
            border-radius: var(--v0-radius); 
            background-color: var(--v0-muted); /* Muted background for param items */
            position: relative; 
        }
        .param-item .remove-param-button { 
            position: absolute; 
            top: 0.5rem; 
            right: 0.5rem; 
            padding: 0.1rem 0.4rem; 
            background-color: var(--v0-background); /* Ensure visibility on muted bg */
            border-color: var(--v0-border);
            color: var(--v0-destructive);
        }
         .param-item .remove-param-button:hover {
             background-color: var(--v0-destructive);
             border-color: var(--v0-destructive);
             color: var(--v0-destructive-foreground);
         }
        .global-setting-item { 
            padding: 1rem 1.5rem; 
            border: 1px solid var(--v0-border); 
            background-color: var(--v0-muted); 
            border-radius: var(--v0-radius); 
            margin-bottom: 1.5rem; 
        }
        .group-title { 
            margin-top: 2rem; /* Reduced top margin */
            margin-bottom: 1rem; 
            font-size: 1.125rem; /* Adjusted group title size */
            font-weight: 600;
            color: var(--v0-muted-foreground); 
            border-bottom: 1px solid var(--v0-border); 
            padding-bottom: 0.5rem; 
        }
        .group-title:first-of-type { margin-top: 0; } 

        /* Alert/Message Styles */
        #message { 
            margin-top: 1.5rem; 
            border-radius: var(--v0-radius);
            padding: 0.75rem 1rem; /* Adjusted padding */
            font-size: 0.875rem;
        }
        .alert-success {
             color: #0f5132; /* Tailwind green-800 */
             background-color: #d1fae5; /* Tailwind green-100 */
             border-color: #a7f3d0; /* Tailwind green-200 */
        }
        .alert-danger {
             color: #991b1b; /* Tailwind red-800 */
             background-color: #fee2e2; /* Tailwind red-100 */
             border-color: #fca5a5; /* Tailwind red-300 */
        }
        
        /* Tooltip */
        .tooltip-icon { cursor: help; color: var(--v0-muted-foreground); margin-left: 0.25rem; vertical-align: middle; }
        .tooltip-inner { background-color: var(--v0-primary); color: var(--v0-primary-foreground); font-size: 0.75rem; padding: 0.375rem 0.625rem; border-radius: var(--v0-radius-sm); box-shadow: var(--v0-shadow); }
        .tooltip.bs-tooltip-top .tooltip-arrow::before { border-top-color: var(--v0-primary); }
        .tooltip.bs-tooltip-bottom .tooltip-arrow::before { border-bottom-color: var(--v0-primary); }
        .tooltip.bs-tooltip-start .tooltip-arrow::before { border-left-color: var(--v0-primary); }
        .tooltip.bs-tooltip-end .tooltip-arrow::before { border-right-color: var(--v0-primary); }

        /* Utility Overrides */
        .mb-4 { margin-bottom: 1.5rem !important; }
        .mt-4 { margin-top: 1.5rem !important; }
        .text-muted { color: var(--v0-muted-foreground) !important; }
        .text-sm-end { text-align: right !important; } 
        .h3 { font-size: 1.25rem; font-weight: 600; } /* Smaller main heading */
        .spinner-border { color: var(--v0-primary); }
        .spinner-border-sm { width: 1rem; height: 1rem; border-width: 0.15em; }
    </style>
</head>
<body>
    <main class="container">
        <div class="d-flex justify-content-between align-items-center mb-4 flex-wrap gap-2">
            <h1 class="h3 mb-0">API 转发配置管理</h1>
             <div class="d-flex gap-2 flex-wrap">
                 <button type="button" class="btn btn-info fetch-emoticons-button" onclick="fetchAndAddEmoticons(this)" disabled><i class="bi bi-cloud-download"></i> 在线拉取表情包</button>
                 <button type="button" class="btn btn-secondary" onclick="addNewGroup()"><i class="bi bi-folder-plus"></i> 添加新分组</button> <!-- Add New Group Button -->
                 <button type="button" class="btn btn-success add-endpoint-button" onclick="addApiEndpoint()"><i class="bi bi-plus-lg"></i> 添加新 API 端点</button>
                 <a href="/admin-logout" class="btn btn-outline-secondary"><i class="bi bi-box-arrow-right"></i> 退出登录</a>
             </div>
        </div>

        <p class="text-muted mb-4">在这里修改、添加或删除 API 转发规则。点击“在线拉取表情包”可自动添加常用表情包 API。所有更改将在点击下方“保存所有配置”按钮后**立即生效**。</p>

        <!-- Batch Actions Section -->
        <div id="batch-actions-section" class="card mb-4" style="display: none;">
            <div class="card-body d-flex flex-wrap align-items-center gap-3">
                 <div class="form-check">
                     <input class="form-check-input" type="checkbox" value="" id="select-all-checkbox" onchange="toggleSelectAll(this.checked)">
                     <label class="form-check-label" for="select-all-checkbox">
                         全选/取消
                     </label>
                 </div>
                 <button id="batch-delete-button" type="button" class="btn btn-danger btn-sm" onclick="batchDeleteEndpoints()" disabled>
                     <i class="bi bi-trash"></i> 批量删除 (<span id="selected-count">0</span>)
                 </button>
                 <div class="input-group input-group-sm" style="max-width: 300px;">
                     <label class="input-group-text" for="batch-move-group-select">移动到分组:</label>
                     <select class="form-select" id="batch-move-group-select" disabled>
                         <option value="" selected disabled>选择目标分组...</option>
                         {/* Group options will be populated by JS */}
                     </select>
                     <button id="batch-move-button" class="btn btn-outline-primary" type="button" onclick="batchMoveGroup()" disabled>
                         <i class="bi bi-folder-symlink"></i> 移动
                     </button>
                 </div>
            </div>
        </div>

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
            // Remove any characters that are not letters, numbers, hyphens, or underscores
            let sanitized = key.replace(/[^a-zA-Z0-9-_]/g, ''); 
            // Allow keys to start with numbers
            return sanitized;
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
            cardHeader.className = 'card-header d-flex justify-content-between align-items-center'; // Use flexbox for alignment
            cardHeader.innerHTML = \`
                <div class="d-flex align-items-center">
                     <input class="form-check-input me-2 endpoint-checkbox" type="checkbox" value="\${apiKey}" onchange="handleCheckboxChange()">
                     <span>端点: /<input type="text" value="\${apiKey}" class="api-key-input" aria-label="API 端点路径" placeholder="路径名" required></span>
                </div>
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
            disposeAllTooltips(); // Dispose existing tooltips before clearing
            apiConfigsContainer.innerHTML = '';
            // --- Get references to batch elements ---
            const batchActionsSection = document.getElementById('batch-actions-section');
            const selectAllCheckbox = document.getElementById('select-all-checkbox');
            const batchMoveGroupSelect = document.getElementById('batch-move-group-select');
            // --- Ensure elements exist before proceeding ---
            if (!batchActionsSection || !selectAllCheckbox || !batchMoveGroupSelect) {
                 console.error("Batch action elements not found in the DOM!");
                 return; // Stop rendering if essential elements are missing
            }

            // Clear previous group options in batch move dropdown
            batchMoveGroupSelect.innerHTML = '<option value="" selected disabled>选择目标分组...</option>';
            // Add "未分组" option explicitly
            batchMoveGroupSelect.add(new Option('未分组', '未分组'));

            const apiUrls = currentConfigData.apiUrls || {};
            const groupedEndpoints = {};
            const allGroupNames = new Set(['未分组']); // Start with '未分组'

            for (const apiKey in apiUrls) {
                const entry = apiUrls[apiKey];
                const group = entry.group || '未分组';
                allGroupNames.add(group); // Collect all unique group names
                if (!groupedEndpoints[group]) { groupedEndpoints[group] = []; }
                groupedEndpoints[group].push({ key: apiKey, config: entry });
            }

            // Populate batch move dropdown with sorted unique group names
            const sortedAllGroupNames = Array.from(allGroupNames).sort((a, b) => {
                 const order = {'通用转发': 1, 'AI绘图': 2, '二次元图片': 3, '三次元图片': 4, '表情包': 5, '696898': 6, '未分组': 99}; // Added 696898
                 return (order[a] || 99) - (order[b] || 99);
            });
            sortedAllGroupNames.forEach(groupName => {
                 if (groupName !== '未分组') { // Avoid adding '未分组' twice
                     batchMoveGroupSelect.add(new Option(groupName, groupName));
                 }
            });


            const sortedGroups = Object.keys(groupedEndpoints).sort((a, b) => {
                 const order = {'通用转发': 1, 'AI绘图': 2, '二次元图片': 3, '三次元图片': 4, '表情包': 5, '696898': 6, '未分组': 99}; // Added 696898
                 return (order[a] || 99) - (order[b] || 99);
            });
            
            console.log('[Debug] Batch Actions Section Element:', batchActionsSection); // Debug Log 1
            const numApiUrls = Object.keys(apiUrls).length;
            console.log('[Debug] Number of API URLs:', numApiUrls); // Debug Log 2

            // --- Always show batch section, buttons might be disabled if empty ---
            console.log('[Debug] Ensuring batch actions section is visible.'); // Debug Log 3b
            batchActionsSection.style.display = 'block'; // Always show batch actions

            // --- Render groups and endpoints ---
            if (numApiUrls === 0) {
                 apiConfigsContainer.innerHTML = '<div class="alert alert-info">当前没有配置任何 API 端点。点击“添加新 API 端点”开始。</div>';
            } else {
                 // Clear container before rendering groups
                 apiConfigsContainer.innerHTML = '';
                 sortedGroups.forEach(groupName => {
                    const groupContainer = document.createElement('div'); // Container for the group
                    groupContainer.id = \`group-\${groupName.replace(/\\s+/g, '-')}\`; // Create an ID for the group container

                    const groupTitle = document.createElement('h2');
                    groupTitle.className = 'group-title d-flex align-items-center'; // Use flex for alignment
                    groupTitle.innerHTML = \`
                         <input type="checkbox" class="form-check-input me-2 group-select-all-checkbox" onchange="toggleSelectGroup(this, '\${groupName}')" aria-label="全选/取消全选 \${groupName} 分组">
                         \${groupName}
                    \`;
                    groupContainer.appendChild(groupTitle); // Add title with checkbox to group container

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
                handleCheckboxChange(); // Update batch counts after removing
                 if (!apiConfigsContainer.querySelector('.card')) {
                     apiConfigsContainer.innerHTML = '<div class="alert alert-info">当前没有配置任何 API 端点。点击“添加新 API 端点”开始。</div>';
                     document.getElementById('batch-actions-section').style.display = 'none'; // Hide batch actions
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

        // --- Batch Action Functions ---

        function getSelectedApiKeys() {
            return Array.from(apiConfigsContainer.querySelectorAll('.endpoint-checkbox:checked')).map(cb => cb.value);
        }

        function updateBatchActionButtonsState() {
            const selectedKeys = getSelectedApiKeys();
            const count = selectedKeys.length;
            const batchDeleteButton = document.getElementById('batch-delete-button');
            const batchMoveButton = document.getElementById('batch-move-button');
            const batchMoveGroupSelect = document.getElementById('batch-move-group-select');
            const selectedCountSpan = document.getElementById('selected-count');
            const selectAllCheckbox = document.getElementById('select-all-checkbox');
            const allCheckboxes = apiConfigsContainer.querySelectorAll('.endpoint-checkbox');

            selectedCountSpan.textContent = count;
            batchDeleteButton.disabled = count === 0;
            batchMoveButton.disabled = count === 0 || !batchMoveGroupSelect.value;
            batchMoveGroupSelect.disabled = count === 0;

            // Update main select-all checkbox state
            if (allCheckboxes.length > 0 && count === allCheckboxes.length) {
                 selectAllCheckbox.checked = true;
                 selectAllCheckbox.indeterminate = false;
            } else if (count > 0) {
                 selectAllCheckbox.checked = false;
                 selectAllCheckbox.indeterminate = true;
            } else {
                 selectAllCheckbox.checked = false;
                 selectAllCheckbox.indeterminate = false;
            }

            // Update group select-all checkboxes
            document.querySelectorAll('.group-select-all-checkbox').forEach(groupCb => {
                 const groupContainer = groupCb.closest('div[id^="group-"]');
                 if (!groupContainer) return;
                 const groupCheckboxes = groupContainer.querySelectorAll('.endpoint-checkbox');
                 const groupSelectedCount = groupContainer.querySelectorAll('.endpoint-checkbox:checked').length;

                 if (groupCheckboxes.length > 0 && groupSelectedCount === groupCheckboxes.length) {
                     groupCb.checked = true;
                     groupCb.indeterminate = false;
                 } else if (groupSelectedCount > 0) {
                     groupCb.checked = false;
                     groupCb.indeterminate = true;
                 } else {
                     groupCb.checked = false;
                     groupCb.indeterminate = false;
                 }
            });
        }

        function handleCheckboxChange() {
            updateBatchActionButtonsState();
        }

        function toggleSelectAll(checked) {
            apiConfigsContainer.querySelectorAll('.endpoint-checkbox').forEach(cb => {
                cb.checked = checked;
            });
            handleCheckboxChange();
        }

        function toggleSelectGroup(groupCheckbox, groupName) {
             const groupContainer = document.getElementById(\`group-\${groupName.replace(/\\s+/g, '-')}\`);
             if (groupContainer) {
                 groupContainer.querySelectorAll('.endpoint-checkbox').forEach(cb => {
                     cb.checked = groupCheckbox.checked;
                 });
             }
             handleCheckboxChange();
        }

        function batchDeleteEndpoints() {
            const selectedKeys = getSelectedApiKeys();
            if (selectedKeys.length === 0) {
                showMessage('请先选择要删除的端点。', 'error');
                return;
            }
            if (confirm(\`确定要删除选中的 \${selectedKeys.length} 个端点吗？此操作将在保存后生效且无法撤销。\`)) {
                let deletedCount = 0;
                selectedKeys.forEach(apiKey => {
                    const card = apiConfigsContainer.querySelector(\`.card[data-api-key="\${apiKey}"]\`);
                    if (card) {
                        const parentGroupContainer = card.parentElement;
                        card.remove();
                        deletedCount++;
                         // Check if group is now empty
                         if (parentGroupContainer && !parentGroupContainer.querySelector('.card')) {
                             const groupTitle = parentGroupContainer.previousElementSibling;
                             if (groupTitle && groupTitle.classList.contains('group-title')) {
                                 groupTitle.remove();
                             }
                             parentGroupContainer.remove();
                         }
                    }
                });
                handleCheckboxChange(); // Update counts and button states
                showMessage(\`已标记删除 \${deletedCount} 个端点。点击“保存所有配置”以确认。\`, 'success');
                 if (!apiConfigsContainer.querySelector('.card')) {
                     apiConfigsContainer.innerHTML = '<div class="alert alert-info">当前没有配置任何 API 端点。点击“添加新 API 端点”开始。</div>';
                     document.getElementById('batch-actions-section').style.display = 'none'; // Hide batch actions
                 }
            }
        }

        function batchMoveGroup() {
            const selectedKeys = getSelectedApiKeys();
            const targetGroup = document.getElementById('batch-move-group-select').value;

            if (selectedKeys.length === 0) {
                showMessage('请先选择要移动的端点。', 'error');
                return;
            }
            if (!targetGroup) {
                showMessage('请选择目标分组。', 'error');
                return;
            }

            let movedCount = 0;
            selectedKeys.forEach(apiKey => {
                const card = apiConfigsContainer.querySelector(\`.card[data-api-key="\${apiKey}"]\`);
                if (card) {
                    const groupInput = card.querySelector(\`input[id="\${apiKey}-group"]\`);
                    if (groupInput) {
                        groupInput.value = targetGroup;
                        movedCount++;
                    }
                }
            });

            // Re-render the entire config to reflect the group changes visually
            // This is simpler than manually moving cards between group containers
            showMessage(\`已将 \${movedCount} 个端点的分组更改为 "\${targetGroup}"。点击“保存所有配置”以确认。\`, 'success');
            // Temporarily store current form data before re-rendering
            const currentFormData = collectFormData();
            currentConfigData.apiUrls = currentFormData.apiUrls; // Update in-memory data
            currentConfigData.baseTag = currentFormData.baseTag;
            renderConfig(); // Re-render based on updated in-memory data
            // Restore checkbox states after re-render (optional, but good UX)
            selectedKeys.forEach(apiKey => {
                 const newCheckbox = apiConfigsContainer.querySelector(\`.endpoint-checkbox[value="\${apiKey}"]\`);
                 if (newCheckbox) newCheckbox.checked = true;
            });
            handleCheckboxChange(); // Update batch counts again after re-render
        }

        function addNewGroup() {
            const newGroupName = prompt("请输入新分组的名称:", "");
            if (!newGroupName || !newGroupName.trim()) {
                showMessage("分组名称不能为空。", "error");
                return;
            }
            const trimmedGroupName = newGroupName.trim();
            const groupId = \`group-\${trimmedGroupName.replace(/\\s+/g, '-')}\`;

            // 检查分组是否已存在 (UI层面)
            if (document.getElementById(groupId)) {
                showMessage(\`分组 "\${trimmedGroupName}" 已经存在。\`, "error");
                return;
            }

            // 创建分组标题和容器
            const groupContainer = document.createElement('div');
            groupContainer.id = groupId;

            const groupTitle = document.createElement('h2');
            groupTitle.className = 'group-title d-flex align-items-center';
            groupTitle.innerHTML = \`
                 <input type="checkbox" class="form-check-input me-2 group-select-all-checkbox" onchange="toggleSelectGroup(this, '\${trimmedGroupName}')" aria-label="全选/取消全选 \${trimmedGroupName} 分组">
                 \${trimmedGroupName}
            \`;
            groupContainer.appendChild(groupTitle);

            // 将新分组添加到容器末尾 (或者可以根据排序规则插入)
            apiConfigsContainer.appendChild(groupContainer);

            // 更新批量移动下拉列表
            const batchMoveGroupSelect = document.getElementById('batch-move-group-select');
            // 检查是否已存在该选项
            let exists = false;
            for (let i = 0; i < batchMoveGroupSelect.options.length; i++) {
                if (batchMoveGroupSelect.options[i].value === trimmedGroupName) {
                    exists = true;
                    break;
                }
            }
            if (!exists) {
                 batchMoveGroupSelect.add(new Option(trimmedGroupName, trimmedGroupName));
                 // 可选：对下拉列表重新排序
                 sortSelectOptions(batchMoveGroupSelect);
            }


            showMessage(\`新分组 "\${trimmedGroupName}" 已添加。您可以在此分组下添加端点，或将现有端点移动到此分组。记得保存配置。\`, 'success');
            groupTitle.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        // Helper function to sort select options (used after adding a new group)
        function sortSelectOptions(selectElement) {
            const options = Array.from(selectElement.options);
            // 保留第一个 "选择目标分组..." 选项
            const firstOption = options.shift();
            const order = {'通用转发': 1, 'AI绘图': 2, '二次元图片': 3, '三次元图片': 4, '表情包': 5, '696898': 6, '未分组': 99};
            options.sort((a, b) => {
                 const orderA = order[a.value] || 99;
                 const orderB = order[b.value] || 99;
                 return orderA - orderB || a.text.localeCompare(b.text);
            });
            selectElement.innerHTML = ''; // 清空
            selectElement.appendChild(firstOption); // 重新添加第一个选项
            options.forEach(option => selectElement.appendChild(option));
        }


        // Helper function to collect current form data before re-rendering after move
        function collectFormData() {
             const updatedApiUrls = {};
             const cards = apiConfigsContainer.querySelectorAll('.card[data-api-key]');
             cards.forEach(card => {
                 const apiKeyInput = card.querySelector('.api-key-input');
                 const apiKey = sanitizeApiKey(apiKeyInput.value.trim());
                 const originalApiKey = card.getAttribute('data-api-key');
                 if (!apiKey) return; // Skip invalid ones for this temporary collection

                 const configEntry = {
                     group: card.querySelector(\`#\${originalApiKey}-group\`).value.trim() || '未分组',
                     description: card.querySelector(\`#\${originalApiKey}-description\`).value.trim(),
                     url: card.querySelector(\`#\${originalApiKey}-url\`).value.trim(),
                     method: card.querySelector(\`#\${originalApiKey}-method\`).value,
                     queryParams: [],
                     proxySettings: {}
                 };
                 // Simplified collection - just get the basics needed for re-render
                 updatedApiUrls[apiKey] = configEntry;
             });
             const currentBaseTagInput = document.getElementById('baseTag');
             return {
                 apiUrls: updatedApiUrls,
                 baseTag: currentBaseTagInput ? currentBaseTagInput.value.trim() : ''
             };
        }


        async function loadConfig() {
            apiConfigsContainer.innerHTML = '<div class="text-center"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">正在加载配置...</span></div><p class="mt-2">正在加载配置...</p></div>'; // Changed to string concatenation
            // The line that hid the batch section initially has been removed.
            try {
                const response = await fetch('/config');
                if (!response.ok) throw new Error(\`HTTP error! status: \${response.status}\`);
                currentConfigData = await response.json();
                if (!currentConfigData.apiUrls) currentConfigData.apiUrls = {};
                renderConfig();
                handleCheckboxChange(); // Initial update for batch buttons
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
        
        // --- New Function: Fetch and Add Emoticons ---
        async function fetchAndAddEmoticons(button) {
            const originalHtml = button.innerHTML;
            button.disabled = true;
            button.innerHTML = \`<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 拉取中...\`;
            
            try {
                showMessage('正在从 https://pic.696898.xyz/pic/list 拉取表情包列表...', 'info');
                const response = await fetch('https://pic.696898.xyz/pic/list');
                if (!response.ok) {
                    throw new Error(\`HTTP error! status: \${response.status}\`);
                }
                const emoticonList = await response.json();
                
                if (!Array.isArray(emoticonList)) {
                     throw new Error('返回的数据格式不是有效的 JSON 数组');
                }
                
                showMessage(\`成功拉取 \${emoticonList.length} 个表情包列表，正在添加到配置中...\`, 'info');
                
                let addedCount = 0;
                let pinyinFunction;

                // Check for pinyin function availability
                if (typeof pinyinPro !== 'undefined' && typeof pinyinPro.pinyin === 'function') {
                    pinyinFunction = pinyinPro.pinyin;
                    console.log("Using pinyin function from pinyinPro.pinyin");
                } else {
                    // Log detailed error information
                    console.error('Pinyin function (pinyinPro.pinyin) not found after delay.');
                    console.log('pinyinPro object:', pinyinPro); 
                    if (pinyinPro) {
                         console.log('typeof pinyinPro.pinyin:', typeof pinyinPro.pinyin);
                    }
                    throw new Error('pinyin-pro 库未能正确加载或初始化。请检查网络连接、浏览器控制台或稍后再试。');
                }
                
                // Ensure the "696898" group container exists
                const targetGroupName = "696898";
                const targetGroupId = \`group-\${targetGroupName}\`;
                let emoticonGroupContainer = apiConfigsContainer.querySelector(\`#\${targetGroupId}\`);
                if (!emoticonGroupContainer) {
                    const groupTitle = document.createElement('h2');
                    groupTitle.className = 'group-title';
                    groupTitle.textContent = targetGroupName;
                    // Find the correct place to insert (e.g., before '未分组' or at the end)
                    const ungroupedContainer = apiConfigsContainer.querySelector('#group-未分组');
                    if (ungroupedContainer) {
                        apiConfigsContainer.insertBefore(groupTitle, ungroupedContainer);
                        emoticonGroupContainer = document.createElement('div');
                        emoticonGroupContainer.id = targetGroupId;
                        apiConfigsContainer.insertBefore(emoticonGroupContainer, ungroupedContainer);
                    } else {
                         apiConfigsContainer.appendChild(groupTitle);
                         emoticonGroupContainer = document.createElement('div');
                         emoticonGroupContainer.id = targetGroupId;
                         apiConfigsContainer.appendChild(emoticonGroupContainer);
                    }
                }

                emoticonList.forEach(item => {
                    if (item.name && item.path) { // Basic validation
                        let pinyinKey;
                        try {
                            // 尝试生成拼音首字母，保留非中文部分
                            let pinyinInitialsRaw = pinyinFunction(item.name, { pattern: 'initial', toneType: 'none', nonZh: 'keep' }); 
                            pinyinKey = sanitizeApiKey(pinyinInitialsRaw.toLowerCase().replace(/\s+/g, ''));
                        } catch (e) {
                            console.warn(\`Pinyin generation failed for "\${item.name}": \${e.message}\`);
                            pinyinKey = null; // 标记生成失败
                        }

                        // 如果拼音生成结果为空或失败，尝试使用原始名称（清理后）
                        if (!pinyinKey) {
                            console.warn(\`无法为 "\${item.name}" 生成有效拼音 Key，尝试使用原名。\`);
                            // 将空格替换为下划线，然后清理
                            pinyinKey = sanitizeApiKey(item.name.toLowerCase().replace(/\s+/g, '_')); 
                        }

                        // 最后检查是否成功生成了 Key
                        if (!pinyinKey) {
                             console.warn(\`无法为 "\${item.name}" 生成任何有效 Key，跳过。\`);
                             return; // 如果两种方法都失败，则跳过
                        }
                        
                        // 检查 Key 是否仍然为空（例如，如果原名只包含无效字符）
                        if (!pinyinKey) {
                             console.warn(\`为 "\${item.name}" 生成的 Key 清理后为空，跳过。\`);
                             return;
                        }
                        
                        // --- 新增：检查当前配置中是否已存在该 Key ---
                        if (currentConfigData.apiUrls[pinyinKey]) {
                            console.log(\`端点 /\${pinyinKey} (\${item.name}) 已存在于当前配置中，跳过添加。\`);
                            return; // 在 forEach 回调中使用 return 来跳过当前项
                        }
                        // --- 检查结束 ---

                        const newConfigEntry = {
                            group: targetGroupName, // Use the target group name
                            description: \`\${item.name} 表情包\`,
                            url: \`https://696898.xyz/pci?type=\${item.name}\`, // Use original name in URL
                            method: "redirect",
                            queryParams: [],
                            proxySettings: {}
                        };
                        
                        // // 不再需要检查和移除 UI 元素，因为我们基于数据进行判断
                        // const existingCard = apiConfigsContainer.querySelector(\`.card[data-api-key="\${pinyinKey}"]\`);
                        // if (existingCard) {
                        //     console.log(\`端点 /\${pinyinKey} 已存在，将覆盖。\`);
                        //     existingCard.remove();
                        // }

                        const cardElement = renderApiEndpoint(pinyinKey, newConfigEntry);
                        emoticonGroupContainer.appendChild(cardElement); // Add card to the "表情包" group
                        addedCount++;
                    } else {
                         console.warn('跳过无效的表情包条目:', item);
                    }
                });
                
                // Re-initialize tooltips for new elements
                setTimeout(() => initializeTooltips(emoticonGroupContainer), 100); 
                
                showMessage(\`成功添加/更新了 \${addedCount} 个表情包 API 端点。请检查配置并点击“保存所有配置”以生效。\`, 'success');
                
            } catch (error) {
                console.error('拉取或处理表情包失败:', error);
                showMessage(\`拉取表情包失败: \${error.message}\`, 'error');
            } finally {
                button.disabled = false;
                button.innerHTML = originalHtml;
            }
        }
        
        document.addEventListener('DOMContentLoaded', () => {
            loadConfig(); // Load existing config first

            // Check for pinyin library and enable button if available
            const fetchButton = document.querySelector('.fetch-emoticons-button');
            if (fetchButton) {
                // Give the CDN script a moment to load, then check
                setTimeout(() => {
                    // Check specifically for the expected function
                    if (typeof pinyinPro !== 'undefined' && typeof pinyinPro.pinyin === 'function') {
                        fetchButton.disabled = false;
                        console.log('pinyin-pro library (pinyinPro.pinyin) loaded successfully. Enabling fetch button.');
                    } else {
                        console.error('pinyin-pro library failed to load or initialize correctly after delay. Fetch button remains disabled.');
                        console.log('pinyinPro object:', pinyinPro);
                         if (pinyinPro) {
                             console.log('typeof pinyinPro.pinyin:', typeof pinyinPro.pinyin);
                         }
                        showMessage('无法加载拼音库，拉取表情包功能不可用。请检查网络、浏览器控制台或刷新页面重试。', 'error');
                    }
                }, 1000); // 1000ms delay
            }
        });
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

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 6667;

// Enable CORS for all routes
app.use(cors());

// Middleware to parse JSON bodies
app.use(express.json());

// Main route for forwarding API requests
app.get('/forward', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    const urlField = req.query.field || 'url'; // 默认字段名为'url'，可以通过field参数自定义
    
    if (!targetUrl) {
      return res.status(400).json({ error: 'Missing URL parameter. Use ?url=https://example.com/api/endpoint&field=imageUrl' });
    }

    // Make the request to the target API
    const response = await axios.get(targetUrl);
    
    // Check if the response contains an image URL
    if (response.data && typeof response.data === 'object') {
      // 如果用户指定了字段名，优先使用用户指定的，然后才是常见字段名
      const possibleImageFields = [urlField, 'url', 'image', 'imageUrl', 'img', 'src', 'path', 'link'];
      
      // Try to find an image URL in the response
      let imageUrl = null;
      
      // 直接检查用户指定的字段名
      if (response.data && response.data[urlField] && typeof response.data[urlField] === 'string') {
        imageUrl = response.data[urlField];
      }
      
      // 如果没有找到，继续检查嵌套结构
      if (!imageUrl) {
        // First check for nested structures like sticker.url
        const commonNestedObjects = ['sticker', 'data', 'result', 'image', 'photo', 'picture'];
        
        for (const nestedObj of commonNestedObjects) {
          if (response.data[nestedObj] && typeof response.data[nestedObj] === 'object') {
            for (const field of possibleImageFields) {
              if (response.data[nestedObj][field] && typeof response.data[nestedObj][field] === 'string') {
                // Check if it looks like an image URL
                if (response.data[nestedObj][field].match(/\.(jpeg|jpg|gif|png|webp)/i)) {
                  imageUrl = response.data[nestedObj][field];
                  break;
                }
              }
            }
            if (imageUrl) break;
          }
        }
      }
      
      // If not found in nested objects, check top level
      if (!imageUrl) {
        for (const field of possibleImageFields) {
          if (response.data[field] && typeof response.data[field] === 'string') {
            // Check if it looks like an image URL
            if (response.data[field].match(/\.(jpeg|jpg|gif|png|webp)/i)) {
              imageUrl = response.data[field];
              break;
            }
          }
        }
      }
      
      // 如果找到图片URL，使用重定向
      if (imageUrl) {
        // 使用重定向到实际图片URL，让客户端直接请求
        return res.redirect(imageUrl);
      }
      
      // If we couldn't find an obvious image URL, return the full response
      return res.json(response.data);
    } else if (typeof response.data === 'string') {
      // If the response is already a string, return it directly
      return res.send(response.data);
    } else {
      // For any other type of response, return it as JSON
      return res.json(response.data);
    }
  } catch (error) {
    console.error('Error forwarding request:', error.message);
    return res.status(500).json({ 
      error: 'Failed to forward request', 
      message: error.message 
    });
  }
});

// Example route specifically for the random sticker API
app.get('/random-sticker', async (req, res) => {
  try {
    const response = await axios.get('https://www.doro.asia/api/random-sticker');
    
    // Extract the URL from the nested structure
    let imageUrl = null;
    if (response.data && response.data.sticker && response.data.sticker.url) {
      imageUrl = response.data.sticker.url;
    } else if (response.data && response.data.url) {
      imageUrl = response.data.url;
    }
    
    if (imageUrl) {
      // 使用重定向到实际图片URL，让客户端直接请求
      return res.redirect(imageUrl);
    }
    
    // If we couldn't find the URL in the expected structure, log the response for debugging
    console.log('Unexpected response structure:', JSON.stringify(response.data, null, 2));
    
    // Return an error message
    return res.status(404).send('Could not find image URL in the response');
  } catch (error) {
    console.error('Error getting random sticker:', error.message);
    return res.status(500).json({ 
      error: 'Failed to get random sticker', 
      message: error.message 
    });
  }
});

// Home route with instructions
app.get('/', (req, res) => {
  res.send(`
    <h1>API转发服务</h1>
    <p>使用这个服务来转发API请求并通过重定向直接展示图片。</p>
    <h2>使用方法：</h2>
    <ul>
      <li><code>/forward?url=https://api-endpoint.com</code> - 转发任意API请求并重定向到图片URL</li>
      <li><code>/random-sticker</code> - 重定向到doro.asia的随机贴纸</li>
    </ul>
    <h2>示例：</h2>
    <p>立即尝试： <a href="/random-sticker" target="_blank">获取随机贴纸</a></p>
    <p>或在img标签中使用： <img src="/random-sticker" alt="随机贴纸" style="max-width: 300px;"></p>
  `);
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 6667;

// Enable CORS for all routes
app.use(cors());

// Middleware to parse JSON bodies
app.use(express.json());

// 基础配置
const BASE_TAG = 'masterpiece%20best%20quality%20high%20detailed';

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

// doro随机贴纸API
app.get('/doro', async (req, res) => {
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
    console.error('Error getting doro:', error.message);
    return res.status(500).json({ 
      error: 'Failed to get doro', 
      message: error.message 
    });
  }
});

// AI绘图 - Flux模型 (2D)
app.get('/flux', async (req, res) => {
  try {
    const tags = req.query.tags || '';
    
    if (!tags) {
      return res.status(400).json({ error: '缺少tags参数，请使用?tags=你的标签' });
    }
    
    // 构建提示词 URL - Flux模型 (2D)
    const promptUrl = `https://image.pollinations.ai/prompt/${tags}%2c${BASE_TAG}?&model=flux&nologo=true`;
    
    // 重定向到生成的图片
    return res.redirect(promptUrl);
  } catch (error) {
    console.error('Error generating AI image with Flux:', error.message);
    return res.status(500).json({ 
      error: 'Failed to generate AI image with Flux', 
      message: error.message 
    });
  }
});

// AI绘图 - Turbo模型 (3D)
app.get('/turbo', async (req, res) => {
  try {
    const tags = req.query.tags || '';
    
    if (!tags) {
      return res.status(400).json({ error: '缺少tags参数，请使用?tags=你的标签' });
    }
    
    // 构建提示词 URL - Turbo模型 (3D)
    const promptUrl = `https://image.pollinations.ai/prompt/${tags}%2c${BASE_TAG}?&model=turbo&nologo=true`;
    
    // 重定向到生成的图片
    return res.redirect(promptUrl);
  } catch (error) {
    console.error('Error generating AI image with Turbo:', error.message);
    return res.status(500).json({ 
      error: 'Failed to generate AI image with Turbo', 
      message: error.message 
    });
  }
});

// 兼容旧的AI绘图API端点
app.get('/draw', async (req, res) => {
  try {
    const tags = req.query.tags || '';
    const model = req.query.model && ['turbo', 'flux'].includes(req.query.model) ? req.query.model : 'flux';
    
    if (!tags) {
      return res.status(400).json({ error: '缺少tags参数，请使用?tags=你的标签' });
    }
    
    // 根据模型重定向到相应端点
    if (model === 'turbo') {
      return res.redirect(`/turbo?tags=${tags}`);
    } else {
      return res.redirect(`/flux?tags=${tags}`);
    }
  } catch (error) {
    console.error('Error with AI image redirect:', error.message);
    return res.status(500).json({ 
      error: 'Failed with AI image redirect', 
      message: error.message 
    });
  }
});

// 随机二次元图片1
app.get('/anime1', async (req, res) => {
  try {
    return res.redirect('http://moe.jitsu.top/api/?sort=setu');
  } catch (error) {
    console.error('Error getting anime image:', error.message);
    return res.status(500).json({ error: 'Failed to get anime image' });
  }
});

// 随机二次元图片2
app.get('/anime2', async (req, res) => {
  try {
    return res.redirect('https://www.loliapi.com/bg');
  } catch (error) {
    console.error('Error getting anime image:', error.message);
    return res.status(500).json({ error: 'Failed to get anime image' });
  }
});

// 蓝档案图片
app.get('/ba', async (req, res) => {
  try {
    return res.redirect('https://pic.696898.xyz/pic?type=ba');
  } catch (error) {
    console.error('Error getting Blue Archive image:', error.message);
    return res.status(500).json({ error: 'Failed to get Blue Archive image' });
  }
});

// 指定二次元图片
app.get('/anime-tag', async (req, res) => {
  try {
    const validKeywords = ['azurlane', 'genshinimpact', 'arknights', 'honkai', 'fate', 'frontline', 'princess', 'idolmaster', 'hololive', 'touhou'];
    const keyword = req.query.keyword || '';
    const size = req.query.size && ['original', 'regular', 'small'].includes(req.query.size) ? req.query.size : 'regular';
    const r18 = req.query.r18 === '1' ? '1' : '0';
    
    if (!keyword || !validKeywords.includes(keyword)) {
      return res.status(400).json({ 
        error: '无效的关键词', 
        validKeywords: validKeywords 
      });
    }
    
    const url = `http://image.anosu.top/pixiv/direct?r18=${r18}&size=${size}&keyword=${keyword}`;
    return res.redirect(url);
  } catch (error) {
    console.error('Error getting anime image with tag:', error.message);
    return res.status(500).json({ error: 'Failed to get anime image with tag' });
  }
});

// 白丝图片
app.get('/baisi', async (req, res) => {
  try {
    return res.redirect('http://v2.api-m.com/api/baisi?return=302');
  } catch (error) {
    console.error('Error getting baisi image:', error.message);
    return res.status(500).json({ error: 'Failed to get baisi image' });
  }
});

// 黑丝图片
app.get('/heisi', async (req, res) => {
  try {
    return res.redirect('http://v2.api-m.com/api/heisi?return=302');
  } catch (error) {
    console.error('Error getting heisi image:', error.message);
    return res.status(500).json({ error: 'Failed to get heisi image' });
  }
});

// 柴郎表情包
app.get('/maomao', async (req, res) => {
  try {
    return res.redirect('https://uapis.cn/api/imgapi/bq/maomao.php');
  } catch (error) {
    console.error('Error getting maomao emoji:', error.message);
    return res.status(500).json({ error: 'Failed to get maomao emoji' });
  }
});

// 奶龙表情包
app.get('/nailong', async (req, res) => {
  try {
    return res.redirect('https://oiapi.net/API/FunBoxEmoji/?0=nailong');
  } catch (error) {
    console.error('Error getting nailong emoji:', error.message);
    return res.status(500).json({ error: 'Failed to get nailong emoji' });
  }
});

// Home route with instructions
app.get('/', (req, res) => {
  res.send(`
    <h1>API转发服务</h1>
    <p>使用这个服务来转发API请求并通过重定向直接展示图片。</p>
    
    <h2>通用转发：</h2>
    <ul>
      <li><code>/forward?url=https://api-endpoint.com</code> - 转发任意API请求并重定向到图片URL</li>
      <li><code>/forward?url=https://api-endpoint.com&field=image</code> - 指定自定义字段名，当API返回的图片URL不在'url'字段时使用</li>
    </ul>
    
    <h2>AI绘图：</h2>
    <ul>
      <li><code>/flux?tags=beautiful%2clandscape</code> - 使用Flux模型生成图片（2D风格）</li>
      <li><code>/turbo?tags=beautiful%2clandscape</code> - 使用Turbo模型生成图片（3D风格）</li>
      <li><code>/draw?tags=beautiful%2clandscape&model=turbo</code> - 兼容旧端点，会重定向到相应模型</li>
    </ul>
    
    <h2>二次元图片：</h2>
    <ul>
      <li><code>/anime1</code> - 随机二次元图片1</li>
      <li><code>/anime2</code> - 随机二次元图片2</li>
      <li><code>/ba</code> - 蓝档案图片</li>
      <li><code>/anime-tag?keyword=genshinimpact</code> - 指定关键词的二次元图片</li>
      <li><code>/anime-tag?keyword=azurlane&size=original&r18=0</code> - 可选参数：size（original/regular/small），r18（0/1）</li>
    </ul>
    
    <h2>三次元图片：</h2>
    <ul>
      <li><code>/baisi</code> - 白丝图片</li>
      <li><code>/heisi</code> - 黑丝图片</li>
    </ul>
    
    <h2>表情包：</h2>
    <ul>
      <li><code>/doro</code> - doro.asia的随机贴纸</li>
      <li><code>/maomao</code> - 柴郎表情包</li>
      <li><code>/nailong</code> - 奶龙表情包</li>
    </ul>
    
    <h2>示例：</h2>
    <div style="display: flex; flex-wrap: wrap; gap: 10px;">
      <div style="text-align: center;">
        <p>随机doro：</p>
        <img src="/doro" alt="随机doro" style="max-width: 200px; max-height: 200px; object-fit: contain;">
      </div>
      <div style="text-align: center;">
        <p>AI绘图(Flux):</p>
        <img src="/ai-flux?tags=beautiful%2clandscape%2cmountains" alt="AI绘图2D" style="max-width: 200px; max-height: 200px; object-fit: contain;">
      </div>
      <div style="text-align: center;">
        <p>AI绘图(Turbo):</p>
        <img src="/ai-turbo?tags=beautiful%2clandscape%2cmountains" alt="AI绘图3D" style="max-width: 200px; max-height: 200px; object-fit: contain;">
      </div>
      <div style="text-align: center;">
        <p>二次元：</p>
        <img src="/anime1" alt="随机二次元" style="max-width: 200px; max-height: 200px; object-fit: contain;">
      </div>
    </div>
  `);
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

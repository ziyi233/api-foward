# API Forwarding Service

一个简单的Node.js服务，用于转发API请求并通过重定向方式提供图片URL。聚合了多种API，包括AI绘图、二次元图片、三次元图片和表情包等。

## 功能特点

- 转发任意API请求并自动提取图片URL
- 聚合多种图片API，提供统一的访问方式
- 支持AI绘图，基于描述词生成图片
- 提供二次元、三次元和表情包等多种图片类型
- 支持自定义URL字段名
- 启用CORS跨域请求
- 使用重定向方式减轻服务器负担
- 支持Docker容器化部署
- 支持Vercel一键部署
- 使用MongoDB存储配置（可选）

## 安装方法

### 本地安装

```bash
git clone https://github.com/ziyi233/api-foward.git
cd api-foward
npm install
```

### Docker部署（没测说是）

```bash
git clone https://github.com/ziyi233/api-foward.git
cd api-foward
docker-compose up -d
```


### 部署到你自己的Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fziyi233%2Fapi-foward&env=MONGODB_URI,MONGODB_DB_NAME,MONGODB_COLLECTION_NAME&envDescription=MongoDB%20connection%20details%20required%20for%20the%20application&envLink=https%3A%2F%2Fgithub.com%2Fziyi233%2Fapi-foward%23environment-variables)


1. Fork本仓库到你的GitHub账户
2. 登录[Vercel](https://vercel.com/)
3. 点击「New Project」，选择你fork的仓库
4. 配置环境变量（见下文）
5. 点击「Deploy」
### MongoDB配置

应用使用MongoDB存储配置信息，这对于Vercel部署是必需的，因为Vercel的文件系统是只读的。

1. 创建一个 [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) 账户
2. 创建一个新的集群
3. 在「Database Access」中创建一个新用户
4. 在「Network Access」中允许从任何地方访问（或者限制为你的IP和Vercel的IP）
5. 获取连接字符串并配置为环境变量
#### 环境变量配置

在Vercel部署时，需要配置以下环境变量：

| 环境变量 | 必填 | 说明 |
| --- | --- | --- |
| `MONGODB_URI` | 是 | MongoDB连接字符串，例如：`mongodb+srv://username:password@cluster0.example.mongodb.net/?retryWrites=true&w=majority` |
| `MONGODB_DB_NAME` | 是 | MongoDB数据库名称，默认为`api-forward` |
| `MONGODB_COLLECTION_NAME` | 是 | MongoDB集合名称，默认为`config` |
| `ENABLE_FILE_OPERATIONS` | 否 | 是否启用文件操作，在Vercel环境中应设置为`false`或不设置 |


> **注意**：由于Vercel的文件系统是只读的，必须使用MongoDB来存储配置。

## 使用方法

### 本地启动

```bash
npm start
```

服务器默认运行在 http://localhost:3000

### 带环境变量的本地启动

```bash
# Windows PowerShell
$env:MONGODB_URI="mongodb+srv://username:password@cluster0.example.mongodb.net"; npm start

# Linux/macOS
MONGODB_URI="mongodb+srv://username:password@cluster0.example.mongodb.net" npm start
```

### Docker启动

```bash
docker-compose up -d
```

### 管理界面

访问 `/admin` 路径可以进入管理界面，配置和管理API端点：

- 本地：http://localhost:3000/admin
- Vercel：https://your-app.vercel.app/admin

## API端点

以下是可用的API端点，你可以直接在我们的演示站点上测试：[https://api-foward.vercel.app](https://api-foward.vercel.app)

### 通用转发

```http
GET /forward?url=https://api-endpoint.com
```

这个端点会将请求转发到指定的URL，并尝试从响应中提取图片URL，然后通过重定向方式返回。

```http
GET /forward?url=https://api-endpoint.com&field=image
```

如果API返回的JSON中图片URL不是存储在`url`字段中，而是其他字段（如`image`、`img`、`src`等），可以通过`field`参数指定。

### AI绘图

```http
GET /flux?tags=beautiful,landscape
```

![Flux模型示例](https://api-foward.vercel.app/flux?tags=beautiful,landscape)

使用Flux模型生成图片（2D风格），标签用逗号分隔。

```http
GET /turbo?tags=beautiful,landscape
```


使用Turbo模型生成图片（3D风格），标签用逗号分隔。

### 二次元图片

```http
GET /anime1
```

![随机二次元图片1](https://api-foward.vercel.app/anime1)

随机二次元图片1。

```http
GET /anime2
```

![随机二次元图片2](https://api-foward.vercel.app/anime2)

随机二次元图片2。

```http
GET /ba
```

![蓝档案图片](https://api-foward.vercel.app/ba)

蓝档案图片。

```http
GET /anime-tag?keyword=genshinimpact
```

![原神图片](https://api-foward.vercel.app/anime-tag?keyword=genshinimpact)

指定关键词的二次元图片。支持的关键词有：`azurlane`，`genshinimpact`，`arknights`，`honkai`，`fate`，`frontline`，`princess`，`idolmaster`，`hololive`，`touhou`。

```http
GET /anime-tag?keyword=azurlane&size=original&r18=0
```

可选参数：`size`（original/regular/small），`r18`（0/1）。

### 三次元图片

```http
GET /baisi
```

![白丝图片](https://api-foward.vercel.app/baisi)

白丝图片。

```http
GET /heisi
```

![黑丝图片](https://api-foward.vercel.app/heisi)

黑丝图片。

### 表情包

```http
GET /doro
```

![doro.asia随机贴纸](https://api-foward.vercel.app/doro)

doro.asia的随机贴纸。

```http
GET /maomao
```

![柴郡表情包](https://api-foward.vercel.app/maomao)

柴郡表情包。

```http
GET /nailong
```

![奶龙表情包](https://api-foward.vercel.app/nailong)

奶龙表情包。

## 使用示例

获取随机贴纸：

```http
https://api-foward.vercel.app/doro
```

转发请求到其他API：

```http
https://api-foward.vercel.app/forward?url=https://www.doro.asia/api/random-sticker
```

指定自定义字段名：

```http
https://api-foward.vercel.app/forward?url=https://some-api.com/image-api&field=imageUrl
```

## 在HTML中使用

```html
<!-- 使用在线版本 -->
<img src="https://api-foward.vercel.app/doro" alt="随机贴纸">

<!-- 或者使用本地版本 -->
<img src="http://localhost:3000/doro" alt="随机贴纸">
```


## GitHub仓库

```text
https://github.com/ziyi233/api-foward.git
```


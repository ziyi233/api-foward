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

## 安装方法

### 本地安装

```bash
git clone https://github.com/ziyi233/api-foward.git
cd api-foward
npm install
```

### Docker部署

```bash
git clone https://github.com/ziyi233/api-foward.git
cd api-foward
docker-compose up -d
```

## 使用方法

### 本地启动

```bash
npm start
```

服务器默认运行在 http://localhost:6667

### Docker启动

```bash
docker-compose up -d
```

## API端点

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
GET /ai-flux?tags=beautiful%2clandscape
```

使用Flux模型生成图片（2D风格），标签用%2c分隔。

```http
GET /ai-turbo?tags=beautiful%2clandscape
```

使用Turbo模型生成图片（3D风格），标签用%2c分隔。

```http
GET /ai-draw?tags=beautiful%2clandscape&model=turbo
```

兼容旧端点，会自动重定向到相应模型端点。

### 二次元图片

```http
GET /anime1
```

随机二次元图片1。

```http
GET /anime2
```

随机二次元图片2。

```http
GET /ba
```

蓝档案图片。

```http
GET /anime-tag?keyword=genshinimpact
```

指定关键词的二次元图片。支持的关键词有：`azurlane`，`genshinimpact`，`arknights`，`honkai`，`fate`，`frontline`，`princess`，`idolmaster`，`hololive`，`touhou`。

```http
GET /anime-tag?keyword=azurlane&size=original&r18=0
```

可选参数：`size`（original/regular/small），`r18`（0/1）。

### 三次元图片

```http
GET /baisi
```

白丝图片。

```http
GET /heisi
```

黑丝图片。

### 表情包

```http
GET /doro
```

doro.asia的随机贴纸。

```http
GET /maomao
```

柴郎表情包。

```http
GET /nailong
```

奶龙表情包。

## 使用示例

获取随机贴纸：

```http
http://localhost:6667/random-sticker
```

转发请求到其他API：

```http
http://localhost:6667/forward?url=https://www.doro.asia/api/random-sticker
```

指定自定义字段名：

```http
http://localhost:6667/forward?url=https://some-api.com/image-api&field=imageUrl
```

## 在HTML中使用

```html
<img src="http://localhost:6667/random-sticker" alt="随机贴纸">
```

## GitHub仓库

```text
https://github.com/ziyi233/api-foward.git
```

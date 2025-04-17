# API Forwarding Service

一个简单的Node.js服务，用于转发API请求并通过重定向方式提供图片URL。

## 功能特点

- 转发任意API请求并自动提取图片URL
- 提供专用的随机贴纸API端点
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

### 转发任意API请求

```
GET /forward?url=https://api-endpoint.com
```

这个端点会将请求转发到指定的URL，并尝试从响应中提取图片URL，然后通过重定向方式返回。

### 自定义URL字段名

```
GET /forward?url=https://api-endpoint.com&field=image
```

如果API返回的JSON中图片URL不是存储在`url`字段中，而是其他字段（如`image`、`img`、`src`等），可以通过`field`参数指定。

### 获取随机贴纸

```
GET /random-sticker
```

这个端点会重定向到doro.asia的随机贴纸图片。

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

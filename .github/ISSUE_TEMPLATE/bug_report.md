name: Bug Report
description: 报告一个问题帮助改进黑小帅
labels: [bug]
body:
  - type: textarea
    id: what-happened
    attributes:
      label: 问题描述
      description: 发生了什么？预期是什么？
      placeholder: 清晰描述问题现象与预期行为
    validations:
      required: true
  - type: dropdown
    id: area
    attributes:
      label: 问题区域
      options:
        - 前端页面（frontend/）
        - API 接口（src/index.js）
        - 部署脚本（deploy.mjs）
        - 数据 / 种子数据（schema.sql / seed.sql）
        - 文档（README / docs）
        - 其他
    validations:
      required: true
  - type: textarea
    id: reproduce
    attributes:
      label: 复现步骤
      placeholder: |
        1. 打开首页 / 调用接口 ...
        2. ...
    validations:
      required: true
  - type: textarea
    id: logs
    attributes:
      label: 报错信息 / 截图
      description: 接口返回、控制台报错或 `npx wrangler tail` 日志
  - type: input
    id: env
    attributes:
      label: 环境
      description: 浏览器 / Node 版本 / wrangler 版本 / 部署地区
    validations:
      required: false

> AI生成

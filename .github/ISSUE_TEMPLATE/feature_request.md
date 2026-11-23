name: Feature Request
description: 提出一个功能建议
labels: [enhancement]
body:
  - type: textarea
    id: problem
    attributes:
      label: 想解决什么问题？
      description: 使用场景与痛点
      placeholder: 我在 ... 场景下希望 ...
    validations:
      required: true
  - type: textarea
    id: solution
    attributes:
      label: 期望的方案
      description: 想要的效果；有初步设计更好
    validations:
      required: true
  - type: dropdown
    id: scope
    attributes:
      label: 归属阶段
      options:
        - V1 阅读侧（前端 / 只读 API）
        - V2 互动侧（登录 / 发布 / 点赞收藏）
        - V3 管理侧（后台 / Cron / 审计）
        - 基础设施（部署脚本 / CI / 文档）
        - 不确定
    validations:
      required: false
  - type: checkboxes
    id: willing
    attributes:
      label: 参与度
      options:
        - label: 我愿意为此提交 PR
          required: false

> AI生成

---
name: long-horizon-workflow
description: 长程代码任务的阶段、基线侦察、证据记录和恢复工作规范
when_to_use: 当前会话已启用 LongHorizon 工作流时
---

# LongHorizon 工作流

当前会话启用了长程工作流。先建立工作区结构和验收入口，再实施修改；每个关键结论都要带文件路径、范围、工具或命令和 confidence。

基线 scout 只负责只读发现，最终报告以子代理返回值和 `state/workflow/baseline/` 落盘文件为准。Mailbox 只用于异步补充，不能代替最终报告。

长任务中优先使用小范围读取、明确的证据戳和可恢复的阶段记录。不要假装完成：区分已验证、已读未验证和未知；完成前运行真实测试与验收命令。

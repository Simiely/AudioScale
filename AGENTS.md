# AGENTS.md · 项目规则

> 写给 AI / 未来维护者的项目上下文。只记录代码里看不出的信息。

## 技术栈

- Adobe ExtendScript（**ES3**）+ AE 2026 ScriptUI 可停靠面板；中/英文版 AE 通用
- 核心机制：调 AE 内置 `Convert Audio to Keyframes` 烘焙振幅 → 表达式映射到 Scale

## 关键坑（改代码前必读）

1. **跨语言兼容（最大坑）**：AE 中文版把**所有名字**本地化——图层名（"Audio Amplitude"→"音频振幅"）、效果名（"Both Channels"→"双声道"）、**连表达式里引用的属性显示名都翻译**（"Slider"→"滑块"）。**永远别在表达式/脚本里写名字**：
   - 表达式侧：全走索引 `effect(3)(1)`
   - 脚本侧找生成图层：用 **diff 前后图层引用**（执行命令前记录所有 layer，执行后找不在原集合的），不靠名字
2. **2D/3D 维度冲突**：别碰 `dimensionsSeparated`，也别给 3D 层 `setValue([x,y])`（触发 AEGP 验证崩溃）。表达式用 **`value` 关键字继承当前维度**（`v=value; v[0]=...; v[1]=...; v`，3D 层 Z 自动保留）
3. **音频无实时读取**：ExtendScript 不能直接读采样；用内置命令烘焙关键帧（"死的"数据——**替换音频后必须重跑脚本**）
4. **表达式引擎不能做 FFT**：频段分离用「复制 N 个音频层 + 各自 Bass & Treble 滤波 + 分别烘焙」，目标层 `index % bandCount` 轮询分配（代价：图层数 ×N）
5. **Undo**：所有操作包在 `app.beginUndoGroup("...")` / `endUndoGroup()` 内

## 约定

- 缩放公式统一 `最终缩放 = 基础缩放 + 振幅增量 × 强度`；三种模式只改振幅预处理方式
- 菜单命令名提供中英文候选数组（`convertAudioToKeyframes` 的 `names` 数组），换版本记得补
- 重复运行会重新生成 Audio Amplitude 层，运行前清理旧层

## 常用命令

- 语法检查：`node --check AudioScale.jsx`（ES3 验证，不能运行 AE API）
- 无构建工具；测试 = AE 中选中音频层 + 目标层 → 应用
- 详细开发记录见 DEVELOPMENT.md

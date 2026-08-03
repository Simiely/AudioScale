# 开发文档（DEVELOPMENT.md）

> 面向开发者的项目文档：架构说明 + 关键问题与方案（一坑一篇）。
> 每个问题用统一格式：**TL;DR**（一句话结论）→ 问题 / 根因 / 解决 / 预防。

## 项目概览

AE 2026 音频驱动缩放脚本（ExtendScript Panel）。调用内置 `Convert Audio to Keyframes` 把音频振幅烘焙为关键帧，再通过表达式映射到目标图层 Scale。三种模式：基础振幅 / 平滑+阈值 / 频段分离。

## 架构说明

```
AudioScale.jsx
├── convertAudioToKeyframes() — 烘焙音频（中英文菜单名候选）
├── findAudioAmplitudeLayer() — diff 前后图层引用找生成层
├── 表达式构建
│   ├── buildScaleExpression() — 基础振幅映射（value 继承维度）
│   ├── buildSmoothExpression()  — 平滑+阈值（smooth + 噪声门限）
│   └── buildBandExpression()    — 频段分离（Bass & Treble 分频）
├── applyToSelectedLayers() — 批量应用（beginUndoGroup 包裹）
└── buildUI() — ScriptUI 面板（模式选择 + 参数）
```

核心公式：`最终缩放 = 基础缩放 + 振幅增量 × 强度`；三种模式只改振幅预处理（原始 / smooth+阈值 / 频段烘焙）。

## 关键问题与方案

### 1. 跨语言兼容 —— 最大的坑

**TL;DR**：AE 中文版把**所有名字本地化**（图层名/效果名/**连表达式引用的属性显示名都翻译**）。唯一可靠锚点：脚本侧用 **diff 前后图层引用**，表达式侧全走**索引** `effect(3)(1)`。

- **问题**：英文版测好的一切，中文版全部匹配失败（"Audio Amplitude"→"音频振幅"、"Both Channels"→"双声道"、"Slider"→"滑块"）
- **解决**：
  - 脚本侧：执行命令前记录所有 `comp.layer(i)` 引用，执行后找不在原集合里的那层（不靠名字）
  - 表达式侧：不写任何名字，全走索引 `effect(3)(1)`
- **预防**：跨语言脚本（表达式/效果/属性引用）一律 matchName（脚本侧）+ 索引（表达式侧），UI 中文只是显示层

### 2. 2D/3D 图层维度冲突

**TL;DR**：向 3D 层的 Scale 写 2 维数组触发 `SetDimensionsSeparated` 内部验证故障（崩溃）。**表达式用 `value` 关键字继承当前维度**，别碰 `dimensionsSeparated`、别 `setValue`。

```javascript
v = value;            // 2D: [x,y]  3D: [x,y,z]
v[0] = baseScale + s;
v[1] = baseScale + s;
v                    // 3D 层 Z 保持原值
```

- **预防**：可能遇到 2D/3D 混合的属性（Scale/Position/Anchor Point）统一用 value 继承维度模式

### 3. 音频数据的获取

**TL;DR**：ExtendScript 没有 API 直接读音频采样。**调用 AE 内置命令 `Convert Audio to Keyframes`** 把振幅烘焙成 Slider 关键帧，脚本只管调度命令 + 挂表达式。

- **约束**：烘焙的关键帧是"死的"——替换音频后必须重跑脚本，无实时方案

### 4. 频段分离的实现

**TL;DR**：表达式引擎不能做 FFT（无法每帧实时分频）。**复制 N 个音频层 → 各自加不同增益的 Bass & Treble → 分别烘焙**，目标层 `index % bandCount` 轮询分配。

- **代价**：图层数 ×N，工程体积和烘焙时间线性增长
- **更精确**：可换 Parametric EQ 设置频率/带宽

## 踩坑时间线（快速对照）

| # | 报错 | 根因 | 修复 |
|---|---|---|---|
| 1 | 未生成 Audio Amplitude 图层 | 中文版图层名本地化，字符串匹配失败 | 改用 diff 前后图层引用 |
| 2 | stream doesn't support separated dimensions | `dimensionsSeparated=false` 触发 AEGP 验证故障 | 删掉该行 |
| 3 | 同上 | `setValue([100,100])` 向 3D 层写 2 维值 | 删掉 setValue |
| 4 | 同上（根因） | 表达式返回 2 维数组给 3D 层 | 用 `value` 关键字继承维度，保留 Z |
| 5 | 名为 "Both channels" 的效果缺失 | 中文版效果显示名是"双声道" | 表达式改用 `effect(3)` 索引 |
| 6 | 名为 "slider" 的属性缺失 | 中文版属性显示名是"滑块" | 表达式改用 `(1)` 索引 |

## 开发环境

- AE 2026 中/英文版 + ExtendScript（ES3）；语法检查 `node --check`
- 无构建工具；测试 = 选中音频层 + 目标层 → 应用

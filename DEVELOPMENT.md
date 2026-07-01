# DEVELOPMENT.md

开发 AudioScale 过程中遇到的几个关键问题与解法。留着以后看。

---

## 1. 跨语言兼容 —— 最大的坑

**问题**：AE 中文版会把脚本/表达式里用到的名字全部本地化。

- `"Audio Amplitude"` → `"音频振幅"`（图层名）
- `"Both Channels"` → `"双声道"`（效果名）
- `"Slider"` → `"滑块"`（属性名）

在英文版测好的一切，中文版全部匹配失败。

**解法**：

- **脚本侧**：找生成的 Audio Amplitude 图层时，不靠名字，用 **diff 前后图层引用**。执行 `Convert Audio to Keyframes` 前记录所有 `comp.layer(i)` 引用，执行后找不在原集合里的那层。
- **表达式侧**：不写任何名字，全走**索引** —— `effect(3)(1)` 代替 `effect("Both Channels")("Slider")`。

**教训**：AE 的本地化不是只有 UI 文本，连表达式里引用的属性显示名都会翻译。唯一可靠的跨语言锚点是 matchName（脚本侧）和索引（表达式侧）。

---

## 2. 2D/3D 图层维度冲突

**问题**：出现 `SetDimensionsSeparated` 内部验证故障。

踩坑路径：
1. 先写 `scaleProp.dimensionsSeparated = false` → 崩
2. 改成 `scaleProp.setValue([100, 100])` → 依然崩
3. 根因：将 2 维数组赋给 3D 层的 Scale 属性，AE 内部尝试切换维度模式触发 AEGP 验证错误

**解法**：表达式用 `value` 关键字继承当前维度：

```javascript
v = value;
v[0] = baseScale + s;
v[1] = baseScale + s;
v
```

2D 图层得 `[x, y]`，3D 图层得 `[x, y, z]`（Z 不变），自动适配。

**教训**：别从脚本侧改维度模式。表达式侧的 `value` 关键字天然继承维度，`[0][1]` 只改你想改的轴，剩下的不动。这个模式适用于所有可能遇到 2D/3D 混合的属性（Position、Anchor Point 等）。

---

## 3. 音频数据的获取

**问题**：ExtendScript 没有 API 直接读取音频采样数据。

**解法**：调用 AE 内置命令 `Convert Audio to Keyframes`，让 AE 把振幅烘焙成 Slider 关键帧。脚本只管调度命令 + 挂表达式，真正的音频解析 Adobe 自己维护。

**约束**：烘焙好的关键帧是"死的"——替换音频后脚本要重新跑。没有实时方案。

---

## 4. 频段分离的实现

**问题**：表达式引擎不能做 FFT，无法在每帧求值时实时分频。

**解法**：复制 N 个音频层 → 每层加不同增益的 `Bass & Treble` 效果 → 各自烘焙成独立的 Audio Amplitude 图层。目标层按 `index % bandCount` 轮询分配。

**代价**：图层数 x N，工程体积和烘焙时间线性增长。

---

## 5. 踩坑时间线

| # | 报错 | 根因 | 修复 |
|---|------|------|------|
| 1 | 未生成 Audio Amplitude 图层 | 中文版图层名本地化，字符串匹配失败 | 改用 diff 前后图层引用 |
| 2 | stream doesn't support separated dimensions | `dimensionsSeparated=false` 触发 AEGP 验证故障 | 删掉该行 |
| 3 | 同上 | `setValue([100,100])` 向 3D 层写 2 维值 | 删掉 setValue |
| 4 | 同上（根因） | 表达式返回 2 维数组给 3D 层 | 用 `value` 关键字继承维度，保留 Z |
| 5 | 名为 "Both channels" 的效果缺失 | 中文版效果显示名是"双声道" | 表达式改用 `effect(3)` 索引 |
| 6 | 名为 "slider" 的属性缺失 | 中文版属性显示名是"滑块" | 表达式改用 `(1)` 索引 |

---

## 总结

| 问题 | 核心解法 | 一句话教训 |
|------|---------|-----------|
| 本地化 | diff 引用 + 索引访问 | 永远别在表达式里写名字 |
| 2D/3D 冲突 | `value` 关键字继承维度 | 别碰 `dimensionsSeparated`，也别 `setValue` |
| 无法读音频 | 借内置命令烘焙关键帧 | 脚本做脚本的事，音频解析交给 AE |
| 无法实时分频 | 复制图层 + 离线滤波 | 表达式能力有限，预处理来补 |
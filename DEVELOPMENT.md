# DEVELOPMENT.md

AudioScale 开发文档。记录关键设计决策、踩坑路径与可延伸的思考点。

---

## 一、架构概览

```
┌─────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│ ScriptUI    │ →   │ 命令编排层           │ →   │ 表达式注入层     │
│ 面板交互    │     │ convertAudioToKeyfra │     │ buildXxxExpr     │
│ 参数收集    │     │ mes / applyBand      │     │ applyScaleExpr   │
└─────────────┘     └──────────────────────┘     └──────────────────┘
                            │
                            ▼
                  ┌──────────────────────┐
                  │ AE 内置命令          │
                  │ Convert Audio to     │
                  │ Keyframes            │
                  └──────────────────────┘
```

**核心分工**：
- 脚本本身**不计算音频**，只负责调度 AE 内置能力 + 生成表达式字符串。
- 真正的"音频→数值"由 AE 的 `Convert Audio to Keyframes` 完成；"数值→缩放"由挂载的表达式在每帧求值时完成。
- 脚本运行是一次性的（点按钮→生成图层+表达式），运行后表达式独立工作，不再依赖脚本。

---

## 二、关键设计点

### 1. 不直接读取音频，而是借力内置命令

**决策**：调用 `app.executeCommand(app.findMenuCommandId("Convert Audio to Keyframes"))`，让 AE 把振幅烘焙成 Slider 关键帧。

**为什么**：
- ExtendScript 无法直接访问音频样本数据，AE 不开放逐采样 API。
- 内置命令生成的关键帧是标准 Slider 属性，可被任意表达式引用，跨版本稳定。
- 复用内置命令意味着 Adobe 自己维护音频解析逻辑（采样率、声道混合、窗口平滑），脚本不需要重造轮子。

**思考延伸**：
- 烘焙式关键帧是"死"的——音频替换后需重新运行脚本。能否改用表达式直接读音频？AE 没有官方 API，但有人用 `footage` 的 sampleImage + 音频转视频的 hack，值得探索。
- 关键帧数据量大（每帧一个值），长视频会让工程膨胀。是否该提供"清理关键帧、改用表达式直接驱动"的开关？

### 2. 图层发现：对比引用而非名字

**决策**：执行内置命令前记录所有图层引用 `beforeLayers.push(comp.layer(i))`，执行后找出不在原数组中的那一层。

**为什么**：
- AE 2026 中文版生成的 Audio Amplitude 图层名是本地化的（如"音频振幅"），靠 `name.indexOf("Audio Amplitude")` 会失败。
- 图层对象引用稳定，`===` 比较比字符串匹配可靠。

**思考延伸**：
- 如果用户在脚本运行期间同时打开多个合成、或脚本执行中途触发了其他图层变更，diff 算法可能误判。是否该用更严格的"效果结构校验"（新图层必须有 3 个 Stereo Mixed 效果）来双重确认？
- 这种 diff 模式可推广到任何"调用 AE 命令后定位产物"的场景——是个通用模式。

### 3. 表达式访问全走索引

**决策**：表达式里 `effect(3)(1)` 而非 `effect("Both Channels")("Slider")`。

**为什么**：
- AE 的效果显示名和属性显示名都会被本地化（中文版 "Both Channels"→"双声道"，"Slider"→"滑块"），表达式里写英文名会在中文版报"效果缺失"。
- 索引访问和语言无关，跨中/英/日文版通用。
- matchName（`ADBE_*` 前缀）在 ExtendScript API 侧也是跨语言固定的，所以脚本里 `property("ADBE Scale")` 这类调用天然安全。

**思考延伸**：
- 索引访问的代价是脆弱——如果 Adobe 改变 Audio Amplitude 图层的效果顺序，脚本会静默错乱（读到 Left/Right 而非 Both）。是否该用 matchName + 显示名候选数组做更鲁棒的查找？
- 表达式引擎在 AE 2026 还支持 JavaScript 表达式引擎（ExtendsScript 引擎已废弃），新引擎下某些 API 行为不同，是否需要做引擎探测？

### 4. 维度继承：用 `value` 关键字而非硬编码数组

**决策**：表达式写成
```javascript
v = value;
v[0] = baseScale + s;
v[1] = baseScale + s;
v
```
而非 `[(baseScale+s), (baseScale+s)]`。

**为什么**：
- 2D 图层 Scale 是 `[x,y]`，3D 图层是 `[x,y,z]`。返回 2 维数组给 3D 层会触发 AE 内部 `SetDimensionsSeparated` 验证故障（"stream doesn't support separated dimensions"）。
- `value` 关键字在表达式上下文中代表"属性当前值"，自动继承维度。改 `[0][1]` 保留 `[2]`，2D/3D 通吃。
- 之前的踩坑路径：先尝试 `dimensionsSeparated = false` → 触发 AEGP 内部错误；再尝试 `setValue([100,100])` → 同样触发。根因是 AE 在某些图层类型上根本不支持运行时切换维度模式，只能靠表达式侧的维度继承绕过。

**思考延伸**：
- 这种"用表达式侧的 value 继承绕过 API 侧的维度限制"是个可复用的模式，适用于任何可能遇到 2D/3D 混合的属性（Position、Anchor Point 等）。
- 3D 层的 Z 缩放被保留原值，但如果用户想要"音频驱动 Z 轴缩放"呢？是否该提供轴向选择？

### 5. 频段分离：复制图层而非实时滤波

**决策**：复制 N 个音频层，每个加 `Bass & Treble` 效果，分别转关键帧。

**为什么**：
- 表达式引擎无法做 FFT，无法在求值时实时分频。
- 复制图层 + 离线效果 + 各自烘焙是唯一可行路径。
- `Bass & Treble` 是简单的低/高频搁架式滤波，参数直观，适合粗分。

**思考延伸**：
- `Bass & Treble` 是搁架式而非真正的带通，频段间重叠严重。要更精确的分频，应换成 `Parametric EQ`（可设中心频率和带宽），甚至用多个 Parametric EQ 串联做 Linkwitz-Riley 交叉滤波。这是个明显的改进方向。
- 复制音频层会成倍增加烘焙时间和工程体积。是否该提供"频段合并模式"——只生成一个 Audio Amplitude，在表达式侧用数学近似（如对振幅做不同时间常数的包络跟随）模拟频段差异？
- 当前目标图层按 `t % ampLayers.length` 轮询分配。如果用户选 4 个目标层 + 3 频段，第 1 和第 4 个图层会共用 Low 频段。是否该提供显式分配 UI？

### 6. Undo 分组

**决策**：所有写操作包在 `app.beginUndoGroup("Audio Scale")` / `endUndoGroup` 内，异常时也确保 endUndoGroup 被调用。

**为什么**：
- ExtendScript 的写操作默认会进 undo 栈，但不分组的话用户需要按很多次 Ctrl+Z 才能撤销完。
- 异常路径下若不 endUndoGroup，AE 的 undo 状态会卡住。

**思考延伸**：
- 当前是单个 undo group。如果脚本做了大量图层操作（频段分离模式会创建 6+ 图层），单次 undo 会让用户无法精细回退。是否该按"阶段"拆分多个 group（转换关键帧 / 挂表达式各一组）？

---

## 三、踩坑时间线（按修复顺序）

| 顺序 | 报错 | 根因 | 修复 |
|------|------|------|------|
| 1 | 未生成 Audio Amplitude 图层 | 中文版图层名本地化，靠名字匹配失败 | 改为对比执行前后图层引用 |
| 2 | stream doesn't support separated dimensions | `dimensionsSeparated = false` 在某些图层类型上触发 AEGP 验证故障 | 去掉直接赋值 |
| 3 | 同上 | `setValue([100,100])` 给 3D 层写 2 维值，AE 内部尝试维度转换触发同样故障 | 去掉 setValue |
| 4 | 同上（根因） | 表达式返回 2 维数组给 3D 层 | 用 `value` 继承维度，只改 `[0][1]` 保留 Z |
| 5 | 名为 "Both channels" 的效果缺失 | 中文版效果显示名是"双声道" | 表达式改用 `effect(3)` 索引 |
| 6 | 名为 "slider" 的属性缺失 | 中文版属性显示名是"滑块" | 表达式改用 `(1)` 索引 |

**教训**：每个坑都是"在英文版测试通过、中文版报错"。**AE 的本地化覆盖范围远超预期**——不只是 UI 文本，连表达式里引用的属性显示名都会被本地化。唯一可靠的跨语言锚点是 matchName（API 侧）和索引（表达式侧）。

---

## 四、可扩展方向

### 1. 更多目标属性
当前只驱动 Scale。同样的振幅数据可以驱动：
- **Opacity**（透明度脉动）
- **Position**（位移抖动，配合不同轴向）
- **Rotation**（旋转脉动）
- **Effect 参数**（如发光强度、模糊量）

架构上只需新增 `buildXxxExpr` 函数族 + UI 上的"目标属性"下拉框。

### 2. 实时预览
当前是"配置 → 点按钮 → 看效果"。能否在拖动滑块时实时更新表达式？ExtendScript 的 ScriptUI 事件可以做到，但要注意性能——每次更新表达式都会触发 AE 重新求值。

### 3. 表达式引擎适配
AE 2026 默认用新的 JavaScript 表达式引擎，语法更严格（如不支持 `with`）。当前脚本生成的表达式是 ES3 风格，两者都能跑，但若引入更现代的语法（如箭头函数、解构）需要做引擎探测。

### 4. 频段分配 UI
当前是 `t % bandCount` 轮询。可以做成"目标图层列表 + 频段下拉框"的显式分配，让用户精确控制每个图层用哪个频段。

### 5. 音频预处理
当前直接用原始音频。可以加"预处理"步骤：归一化、降噪、压缩，让振幅数据更可控。这需要调用 AE 的音频效果或外部工具。

### 6. 性能优化
长视频下，每个目标层都挂表达式去读 Audio Amplitude 的 Slider。表达式求值是每帧一次，N 个目标层 × M 帧 = N×M 次求值。是否可以预计算成查找表？

---

## 五、开发环境

- **语言**：ExtendScript（ES3 子集，无 Array.forEach / JSON 等）
- **运行时**：After Effects 的 ExtendScript 引擎
- **调试**：
  - Adobe ExtendScript Toolkit（旧版，已停止维护）
  - VSCode + [ExtendScript Debugger](https://marketplace.visualstudio.com/items?itemName=Adobe.extendscript-debug) 扩展
- **测试**：手动在 AE 里运行，无自动化测试框架

### 调试技巧

```javascript
// 写日志到文件（ExtendScript 无 console）
function log(msg){
    var f = new File("~/Desktop/audioscale.log");
    f.encoding = "UTF-8";
    f.open("a");
    f.writeln(new Date().toString() + " " + msg);
    f.close();
}

// 弹窗查看对象结构
alert(obj.toSource());
```

---

## 六、文件结构

```
AudioScale/
├── AudioScale.jsx     # 主脚本（单文件，约 280 行）
├── README.md          # 用户文档
├── DEVELOPMENT.md     # 本文档
└── .gitignore
```

单文件设计的好处是部署简单（复制一个文件即可），坏处是函数多了会臃肿。如果未来扩展到多属性驱动，建议拆成模块（用 `#include` 引入，或打包成 .jsxbin）。

---

## 七、思考题

留几个开放问题，给二次开发者：

1. **音频驱动 vs 关键帧驱动**：当前方案把音频烘焙成关键帧再驱动。如果改成"表达式直接读音频文件 + 实时计算振幅"，技术上是否可行？工程复杂度 vs 用户体验的权衡点在哪？

2. **离线 vs 实时**：烘焙关键帧是"离线预处理"，表达式求值是"实时计算"。两者在 AE 里有明确的性能边界吗？哪种更适合长视频？哪种更适合交互式预览？

3. **本地化的根本解法**：当前用索引绕过本地化问题。但如果 AE 未来版本调整了效果顺序，索引会失效。能否设计一种"matchName + 索引双重定位"的策略，既跨语言又抗版本变化？

4. **维度继承的边界**：`value` 继承维度解决了 Scale 的 2D/3D 问题。但 Position、Anchor Point 在 3D 层上还有更复杂的行为（如 Anchor Point 的相对坐标系）。这套模式能直接复用吗？

5. **表达式 vs 脚本**：当前把映射逻辑放在表达式里（每帧求值）。如果改成脚本逐帧写入关键帧（一次性生成），优劣各是什么？哪种更适合需要"手动微调关键帧"的工作流？

6. **频段分离的精度 vs 复杂度**：`Bass & Treble` 粗糙但简单，`Parametric EQ` 精确但参数多。在"用户易用性"和"音频质量"之间，应该如何设计默认值和高级选项的分层？

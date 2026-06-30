// AudioScale.jsx — 通过音频驱动图层缩放
// 模式：基础振幅映射 / 平滑+阈值 / 频段分离
// 兼容 After Effects 2026 (ExtendScript)
// 安装：放入 Scripts/ScriptUI Panels/ 后重启 AE，菜单 窗口 > AudioScale.jsx

(function AudioScaleUI(thisObj){
    var MODE_BASIC  = "基础振幅映射";
    var MODE_SMOOTH = "平滑+阈值";
    var MODE_BAND   = "频段分离";

    // ============ 主 UI ============
    function buildUI(thisObj){
        var win = (thisObj instanceof Panel)
            ? thisObj
            : new Window("palette", "Audio Scale", undefined, {resizeable:true});
        win.orientation = "column";
        win.alignChildren = ["fill","top"];
        win.margins = 12; win.spacing = 8;

        win.add("statictext", undefined, "模式：");
        var modeList = win.add("dropdownlist", undefined, [MODE_BASIC, MODE_SMOOTH, MODE_BAND]);
        modeList.selection = 0;

        win.add("statictext", undefined, "强度（振幅→缩放像素）：");
        var intensity = win.add("slider", undefined, 30, 0, 200);
        intensity.preferredSize.width = 220;
        var intensityTxt = win.add("edittext", undefined, "30");
        intensityTxt.preferredSize.width = 50;

        win.add("statictext", undefined, "基础缩放（%）：");
        var baseScale = win.add("edittext", undefined, "100");
        baseScale.preferredSize.width = 50;

        var gSmooth = win.add("panel", undefined, "平滑/阈值");
        gSmooth.orientation = "column"; gSmooth.alignChildren = ["fill","top"];
        gSmooth.add("statictext", undefined, "平滑宽度（秒）：");
        var smoothW = gSmooth.add("edittext", undefined, "0.1");
        gSmooth.add("statictext", undefined, "底噪阈值：");
        var threshold = gSmooth.add("edittext", undefined, "8");

        var gBand = win.add("panel", undefined, "频段");
        gBand.orientation = "column"; gBand.alignChildren = ["fill","top"];
        gBand.add("statictext", undefined, "频段数（2 或 3）：");
        var bandCount = gBand.add("edittext", undefined, "3");

        var btn = win.add("button", undefined, "应用到选中图层");

        function updateVisibility(){
            gSmooth.visible = (modeList.selection.text === MODE_SMOOTH);
            gBand.visible   = (modeList.selection.text === MODE_BAND);
            win.layout.layout(true);
        }
        modeList.onChange = updateVisibility;
        updateVisibility();

        intensity.onChanging = function(){ intensityTxt.text = Math.round(intensity.value); };
        intensityTxt.onChange = function(){ var v=parseFloat(intensityTxt.text); if(!isNaN(v)) intensity.value=v; };

        btn.onClick = function(){
            var opts = {
                mode: modeList.selection.text,
                intensity: parseFloat(intensityTxt.text) || 0,
                baseScale: parseFloat(baseScale.text) || 100,
                smoothW: parseFloat(smoothW.text) || 0.1,
                threshold: parseFloat(threshold.text) || 0,
                bandCount: parseInt(bandCount.text,10) || 3
            };
            try {
                app.beginUndoGroup("Audio Scale");
                applyAudioScale(opts);
                app.endUndoGroup();
            } catch(e){
                try{ app.endUndoGroup(); }catch(_){}
                alert("出错：" + e.toString());
            }
        };

        if(win instanceof Window){
            win.layout.layout(true);
            win.layout.resize();
            win.onResizing = win.onResize = function(){ this.layout.resize(); };
        }
        return win;
    }

    // ============ 工具函数 ============
    function getSelectedAudioLayer(comp){
        for(var i=1;i<=comp.numLayers;i++){
            var l = comp.layer(i);
            if(l.selected && l.hasAudio && l.property("ADBE Audio Group")) return l;
        }
        return null;
    }

    function getTargetLayers(comp, audioLayer){
        var arr = [];
        for(var i=1;i<=comp.numLayers;i++){
            var l = comp.layer(i);
            if(l.selected && l !== audioLayer && l.property("ADBE Transform Group")) arr.push(l);
        }
        return arr;
    }

    // 调用 AE 内置“将音频转换为关键帧”，返回生成的 Audio Amplitude 图层
    // 注意：不依赖图层名匹配（AE 2026 中文版生成的图层名可能本地化），改为对比新增图层
    function convertAudioToKeyframes(comp, audioLayer, suffix){
        // 记录执行前的图层引用（用 === 比较，比 name 更可靠）
        var beforeLayers = [];
        for(var i=1;i<=comp.numLayers;i++) beforeLayers.push(comp.layer(i));

        for(var i=1;i<=comp.numLayers;i++) comp.layer(i).selected=false;
        audioLayer.selected = true;

        // 多语言菜单名候选
        var names = [
            "Convert Audio to Keyframes",
            "将音频转换为关键帧",
            "音频转换为关键帧",
            "Audio to Keyframes"
        ];
        var cmdId = 0;
        for(var n=0;n<names.length;n++){ cmdId = app.findMenuCommandId(names[n]); if(cmdId) break; }
        if(!cmdId) throw new Error("找不到 'Convert Audio to Keyframes' 菜单（中文版请在脚本 names 数组里补充实际菜单名）");
        app.executeCommand(cmdId);

        // 执行命令后，通过对比找出新增的图层（不依赖名字）
        var found = null;
        for(var j=1;j<=comp.numLayers;j++){
            var layer = comp.layer(j);
            var existed = false;
            for(var k=0;k<beforeLayers.length;k++){
                if(beforeLayers[k] === layer){ existed = true; break; }
            }
            if(!existed){ found = layer; break; }
        }

        // 兜底：如果对比没找到，按名字关键词匹配（中英文都覆盖）
        if(!found){
            for(var m=1;m<=comp.numLayers;m++){
                var nm = comp.layer(m).name;
                if(nm.indexOf("Audio Amplitude")===0 ||
                   nm.indexOf("Amplitude")>=0 ||
                   nm.indexOf("音频")>=0 ||
                   nm.indexOf("振幅")>=0){
                    found = comp.layer(m);
                    break;
                }
            }
        }

        if(!found){
            var msg = "未生成 Audio Amplitude 图层。\n";
            msg += "执行前 " + beforeLayers.length + " 层，执行后 " + comp.numLayers + " 层。\n";
            if(comp.numLayers > beforeLayers.length){
                msg += "新增图层：";
                for(var p=1;p<=comp.numLayers;p++){
                    var existed2 = false;
                    for(var q=0;q<beforeLayers.length;q++){
                        if(beforeLayers[q] === comp.layer(p)){ existed2 = true; break; }
                    }
                    if(!existed2) msg += " [" + comp.layer(p).name + "]";
                }
                msg += "\n请在脚本中把上述图层名加入匹配逻辑。";
            }
            throw new Error(msg);
        }
        if(suffix) found.name = "Audio Amplitude " + suffix;
        return found;
    }

    function applyScaleExpression(target, expr){
        var scaleProp = target.property("ADBE Transform Group").property("ADBE Scale");
        // 关键：不要调用 setValue 或 dimensionsSeparated，二者在 3D 图层 /
        // 某些流类型上会触发 AE 内部 "SetDimensionsSeparated" 验证故障。
        // 表达式本身用 value 关键字继承当前维度（2D 返回 [x,y]，3D 返回 [x,y,z]），
        // 只改 X/Y 保留 Z，从根上避免维度不匹配。
        try { scaleProp.expression = ""; } catch(_){}
        scaleProp.expression = expr;
    }

    // ============ 表达式生成 ============
    // 全部用 value 关键字继承 Scale 当前维度：
    //   2D 图层 value=[x,y] → 只改 [0][1]
    //   3D 图层 value=[x,y,z] → 只改 [0][1]，保留 [2]（Z 缩放）
    // 这样不会因维度不匹配触发 AE 的 SetDimensionsSeparated 内部验证故障。
    //
    // 关键：不写死效果显示名 "Both Channels"（中文版叫"双声道"会找不到）。
    // 改成在脚本侧探测 Audio Amplitude 图层上 effect 的 matchName，
    // 找到包含 "Stereo" 或 "Both" 的那个效果索引，再把索引写进表达式。
    // matchName 是跨语言固定的，比显示名可靠。
    function findBothChannelsEffectIndex(ampLayer){
        var fx = ampLayer.property("ADBE Effect Parade");
        // Audio Amplitude 图层效果顺序固定：1=Left, 2=Right, 3=Both
        // 取第 3 个即 Both Channels（双声道），不靠显示名，跨语言通用
        if(!fx || fx.numProperties < 3) return 1; // 异常兜底
        return 3;
    }

    function buildBasicExpr(name, bothIdx, o){
        return 'amp=thisComp.layer("' + name + '").effect(' + bothIdx + ')(1);\n'
             + 's=amp*' + o.intensity + ';\n'
             + 'v=value;\n'
             + 'v[0]=' + o.baseScale + '+s;\n'
             + 'v[1]=' + o.baseScale + '+s;\n'
             + 'v';
    }
    function buildSmoothExpr(name, bothIdx, o){
        return 'ampP=thisComp.layer("' + name + '").effect(' + bothIdx + ')(1);\n'
             + 'a=ampP.smooth(' + o.smoothW + ',5);\n'
             + 'th=a>' + o.threshold + '?a-' + o.threshold + ':0;\n'
             + 's=th*' + o.intensity + ';\n'
             + 'v=value;\n'
             + 'v[0]=' + o.baseScale + '+s;\n'
             + 'v[1]=' + o.baseScale + '+s;\n'
             + 'v';
    }
    function buildBandExpr(name, bothIdx, o){
        return 'amp=thisComp.layer("' + name + '").effect(' + bothIdx + ')(1);\n'
             + 's=amp*' + o.intensity + ';\n'
             + 'v=value;\n'
             + 'v[0]=' + o.baseScale + '+s;\n'
             + 'v[1]=' + o.baseScale + '+s;\n'
             + 'v';
    }

    // ============ 主逻辑 ============
    function applyAudioScale(opts){
        var comp = app.project.activeItem;
        if(!comp || !(comp instanceof CompItem)){ alert("请先打开一个合成"); return; }
        var audioLayer = getSelectedAudioLayer(comp);
        if(!audioLayer){ alert("请选中一个含音频的图层"); return; }
        var targets = getTargetLayers(comp, audioLayer);
        if(targets.length===0){ alert("请同时选中要缩放的目标图层（Ctrl/Shift 多选）"); return; }

        if(opts.mode === MODE_BAND){
            applyBand(comp, audioLayer, targets, opts);
        } else {
            var amp = convertAudioToKeyframes(comp, audioLayer, null);
            var bothIdx = findBothChannelsEffectIndex(amp);
            var expr = (opts.mode === MODE_BASIC)
                ? buildBasicExpr(amp.name, bothIdx, opts)
                : buildSmoothExpr(amp.name, bothIdx, opts);
            for(var i=0;i<targets.length;i++) applyScaleExpression(targets[i], expr);
        }
    }

    // 频段分离：复制音频层，加 Bass & Treble 粗分频，各自转关键帧
    function applyBand(comp, audioLayer, targets, opts){
        var n = opts.bandCount; if(n<2) n=2; if(n>3) n=3;
        var cfg = [
            {suffix:"Low",  bass:24,  treble:-24},
            {suffix:"Mid",  bass:-6,  treble:-6},
            {suffix:"High", bass:-24, treble:24}
        ];
        var ampLayers = [];
        for(var k=0;k<n;k++){
            var dup = audioLayer.duplicate();
            dup.name = audioLayer.name + "_" + cfg[k].suffix;
            var fx = dup.property("ADBE Effect Parade");
            var bt = fx.addProperty("ADBE Bass & Treble");
            bt.property("ADBE Bass").setValue(cfg[k].bass);
            bt.property("ADBE Treble").setValue(cfg[k].treble);
            dup.moveToEnd();
            var amp = convertAudioToKeyframes(comp, dup, cfg[k].suffix);
            dup.enabled = false;            // 转换完成后隐藏视频，避免遮挡
            ampLayers.push(amp);
        }
        for(var i=1;i<=comp.numLayers;i++) comp.layer(i).selected=false;
        for(var t=0;t<targets.length;t++){
            var idx = t % ampLayers.length;   // 目标层轮询分配到不同频段
            var bothIdx = findBothChannelsEffectIndex(ampLayers[idx]);
            applyScaleExpression(targets[t], buildBandExpr(ampLayers[idx].name, bothIdx, opts));
        }
    }

    // ============ 启动 ============
    var ui = buildUI(thisObj);
    if(ui instanceof Window) ui.show();
})(this);

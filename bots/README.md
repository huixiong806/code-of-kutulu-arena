# bots/

五档 AI 的**编译产物**。服务端启动时按文件名找它们，找不到就不显示对应难度——
不会出现「点了没反应」的按钮。

## 仓库里带了什么

五只全带了，clone 下来就能玩全部档位：

| 档位 | 文件 | 身份 |
| --- | --- | --- |
| 入门 | `baseline_rank212.exe` | 最早的手写启发式，纯规则、无搜索无网络 |
| 简单 | `kutulu_v2.exe` | 第一代搜索版（3 层 beam + 两种对手假设） |
| 中等 | `kutulu_wide.exe` | 加宽 beam 的搜索版 |
| 困难 | `casper_c23_v32.exe` | PUCT + 神经网络（群友 mbfCasper） |
| 极难 | `clawd_r4_fast2.exe` | PUCT + 9k 参数网络、22ms 硬截断（群友 clawd-kaozi） |

仓库只提供编译好的程序，源码暂不公开。换成自己的 bot 见下一节。

## 加自己的 bot

1. 编好一个符合 CodinGame 输入输出协议的 bot 可执行文件；
2. 放进 `bots/`，命名随意（Windows 带 `.exe`）；
3. 改 `server/game/bots.js` 里的难度表：

```js
export const DIFFICULTIES = {
  novice: { label: "入门", file: "baseline_rank212", desc: "手写启发式" },
  easy:   { label: "简单", file: "your_bot",        desc: "我的第一个搜索版" },
  // ...
};
```

`file` 填不带后缀的文件名。改完刷新页面，座位上就会多出对应按钮。

## 平台差异

这五只是 **Windows x64** 的 PE 可执行文件（Linux/macOS 上跑不了）。
在别的系统上要么用 wine，要么改 `server/game/bots.js` 指向自己编的版本——
难度表里只认文件名，不关心它是什么格式。

## 协议

启动时读一行 `宽 高 地图… 四个参数`，之后每回合读 `entityCount` + 若干实体行，
输出一行动作。服务端给每个 AI 座位常驻一个子进程，一局结束（或房间销毁）时回收。

## 调档

```bash
node tools/tournament.mjs 48                  # 随机四人混战，排平均名次
node tools/roundrobin.mjs  a b c d 40         # 固定四人循环赛（座位轮转）
node tools/ladderstats.mjs 1000 4             # 大规模混战，写 data/ladder.json
```

`ladderstats` 的结果会渲染在游戏内规则页的「五档 AI 实测强度」里。

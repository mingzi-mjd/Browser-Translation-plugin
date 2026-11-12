# Windows 原生语音识别服务

使用 faster-whisper 或 whisper.cpp，在 Windows 本机提供插件所需的 HTTP 接口。无需 Docker、WSL 或单独安装 FFmpeg；CPU 模式不需要 CUDA，AMD / Intel 显卡可使用 Vulkan 后端。该服务只负责语音转文字，译文仍由插件现有翻译引擎生成。

## 第一次安装

1. 安装 **64 位 Python 3.11**（[Python 官方下载](https://www.python.org/downloads/windows/)），保留 Python Launcher，或将 Python 加入 PATH。
2. 双击此目录的 **install.cmd**。它在此目录创建 `.venv`，通过 pip 安装依赖，不修改全局 Python 包，不要求管理员权限。
3. 安装完成后双击 **start.cmd**。首次启动会下载 `Systran/faster-whisper-small`，保存在此目录的 `models`；需要访问 Hugging Face 并等待下载完成。
4. 控制台显示 **READY** 后再开启插件听译。保持服务窗口打开，Ctrl+C 停止服务。以后只需运行 start.cmd。

CPU 模式仍需按你的电脑实测，识别速度取决于处理器和模型，不保证能跟上实时播放。AMD / Intel 显卡可使用下方的 Vulkan 后端；本项目已在 RX 9070 XT 上完成实测。

## 插件怎么填写

在目标视频页点击工具栏插件按钮 → **通用视频听译 · 语音识别服务**：

| 项目 | 默认值 |
| --- | --- |
| 基础地址 | `http://127.0.0.1:8000/v1` |
| 模型 ID | `Systran/faster-whisper-small` |
| API Key | 留空，除非你设置了下方的认证环境变量 |
| 原语言 | 自动识别，或手动指定 |
| 分段 | 先使用默认 2 秒（停顿时提前发送） |

点击「获取可用模型 / 检查连接」会列出服务当前加载的模型。它不会安装或切换模型；需要切换模型时停止服务，以新模型参数重新启动，再在插件选择新的 ID。

Speaches 仍然可用，填写其 `/v1` 地址和模型 ID 即可。两个服务不要同时占用同一个端口。

## PowerShell 自定义启动

在此目录打开 PowerShell。脚本无需激活虚拟环境。

```powershell
# 指定 Python 路径安装（支持 Python 3.10–3.12 x64）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Python 'C:\Python311\python.exe'

# 换成较小模型，减少计算量（可能降低识别准确率）
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -Model Systran/faster-whisper-base

# 改端口与 CPU 线程数
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -Port 8001 -Threads 6

# 使用已下载的 CTranslate2 / faster-whisper 模型目录
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -Model 'D:\Models\whisper-small' -ModelId 'my-whisper-small'

# NVIDIA GPU：需先自行配置兼容的 CUDA / cuDNN 运行库
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -Device cuda -ComputeType float16
```

自定义本地模型目录必须是 faster-whisper 支持的 CTranslate2 格式，不能使用 whisper.cpp 的 GGML 模型。GPU 依赖请参考 [faster-whisper 官方说明](https://github.com/SYSTRAN/faster-whisper#gpu)，脚本不会自动安装 GPU 驱动或运行库。CPU 默认使用 `int8`。

## AMD / Intel GPU（Vulkan）

上面的 `-Device cuda` 只适用于 NVIDIA CUDA。AMD 显卡（已在 Radeon RX 9070 XT / Windows 10 22H2 实测）或 Intel 显卡可使用 whisper.cpp 的 Vulkan 后端，不需要 CUDA 或 ROCm。

首次在其他机器使用时，双击 **install-whispercpp.cmd** 下载 Windows Vulkan 包和 `ggml-small.bin`；脚本会校验 SHA256。需要 64 位 Python 3.10–3.12，代理只使用标准库。当前本机已经准备好，可直接跳过安装步骤。

双击 **start-whispercpp.cmd**；不要和 `start.cmd` 同时运行，二者都会占用 8000 端口。它会：

1. 在 `127.0.0.1:8080` 启动 `whisper-server.exe`，使用 Vulkan GPU。
2. 在 `127.0.0.1:8000` 启动兼容 `/v1` 的本地代理，补齐 `/v1/models`、`/health`、CORS 和可选 Bearer 认证。
3. 控制台出现 `READY` 后，在插件中填写：

| 项目 | 值 |
| --- | --- |
| 基础地址 | `http://127.0.0.1:8000/v1` |
| 模型 ID | `whisper-small` |
| API Key | 留空，除非设置 `LOCAL_ASR_API_KEY` |
| 原语言 | 自动识别，或手动指定 |
| 分段 | 2 秒 |

实测（RX 9070 XT，`ggml-small.bin`；首次请求包含预热约 1.5 秒，预热后如下）：

- 11 秒英文音频：约 0.12 秒（预热后）
- 2 秒英文分段：约 0.06 秒
- 6.1 秒中文音频：约 0.10 秒

中文可能输出繁体字，这是 Whisper 模型行为，不影响后续翻译。需要更稳定的简体输出时，可加启动参数：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-whispercpp.ps1 -Prompt '以下是普通话的句子，请使用简体中文。'
```

切换模型：

```powershell
# 先下载 https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-whispercpp.ps1 `
  -Model .\models\ggml-large-v3-turbo.bin -ModelId whisper-large-v3-turbo
```

安装脚本默认只校验 `ggml-small.bin`；换用其他模型时请手动下载并核对来源，或修改脚本中的 `ModelUrl` / `ModelSha256`。

其他参数：`-Port` 改代理端口，`-UpstreamPort` 改 whisper-server 端口，`-Threads` 改 CPU 线程数，`-Language` 改服务默认语言，`-Binary` 指定自定义 `whisper-server.exe`。两个服务都只监听回环地址，不要将端口暴露到局域网。

Vulkan 包是未签名的社区 Windows 构建，安装脚本会校验固定 SHA256；长期使用建议按 [whisper.cpp 官方说明](https://github.com/ggml-org/whisper.cpp#vulkan-gpu-support) 使用 `cmake -B build -DGGML_VULKAN=1` 自行构建，并通过 `-Binary` 指向自己的程序。

可选开启认证，环境变量只对当前 PowerShell 及其子进程生效：

```powershell
$env:LOCAL_ASR_API_KEY = '替换为你自己设置的密钥'
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1

# Vulkan 代理同样读取这个环境变量
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-whispercpp.ps1
```

然后在插件语音识别配置中填写相同 Key。不要将密钥写入仓库。

## 接口与边界

- 仅监听 `127.0.0.1`，不提供局域网公开服务。默认不启用认证；可用上述环境变量启用 Bearer 认证。
- `GET /health`：服务就绪信息。
- `GET /v1/models`：当前已加载模型。
- `POST /v1/audio/transcriptions`：multipart 表单，包含 `file`、`model`、可选 `language`、`response_format`。支持 `json`、`verbose_json`、`text`。
- 上传仅接受完整的单声道 16-bit PCM WAV，16 / 22.05 / 24 / 44.1 / 48 kHz，最长 30 秒、整个请求最多 4 MiB，适配插件的短音频分段。
- 模型启动时加载一次并复用，一次只处理一个请求，忙时返回 429。客户端中止请求不能强制打断已在执行的模型推理，需等待当前段完成。
- 音频和转写结果只在内存中处理，不写入音频或字幕历史；模型文件会保留。插件的翻译缓存规则保持不变。
- 允许扩展来源和无 Origin 的本地客户端，拒绝普通网页 Origin；不对互联网网站开放通用 CORS。

## 排错

- **找不到 Python / py -3.11 失败**：安装 Python 3.11 x64，或用 `install.ps1 -Python` 指定已安装的 3.10–3.12。
- **pip 下载失败**：检查网络、代理和证书，解决后重新运行 install.cmd，不必删除虚拟环境。
- **启动长时间未出现 READY**：查看模型下载进度。首次模型下载可能较慢，完成前插件不能正常识别。
- **端口被占用**：停止原先的 Speaches / 识别服务，或用 `-Port 8001` 并同步修改插件地址。
- **模型 404**：点击插件「获取可用模型」，选择服务列出的完整 ID。
- **缺少 DLL / GPU 初始化失败**：先恢复 CPU 默认参数；按官方说明配置 CUDA，部分 Windows 环境也需要 Microsoft Visual C++ 运行库。
- **AMD 显卡提示 CUDA 不可用**：不要用 `start.ps1 -Device cuda`，改用 `start-whispercpp.cmd`。
- **Vulkan 启动失败**：更新显卡驱动，确认 `vulkaninfo --summary` 能看到显卡；仍失败可尝试在启动参数中给 `whisper-server` 加 `-nfa` 关闭 flash attention。
- **Vulkan 端口冲突**：先停止旧的 CPU / CUDA 服务；默认代理用 8000，whisper-server 用 8080。
- **429 / 超时**：等待前一个推理结束，换较小模型或 GPU 后再试。暂停、拖动视频后可能有旧请求仍在后台推理。

本项目独立实现 HTTP 包装层。faster-whisper 后端依赖 [faster-whisper](https://github.com/SYSTRAN/faster-whisper)（MIT）；Vulkan 后端依赖 [whisper.cpp](https://github.com/ggml-org/whisper.cpp)（MIT）。各自许可证适用。

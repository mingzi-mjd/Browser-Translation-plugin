# 通用视频听译：部署本地 Speaches

这是可选后端。Windows 用户不想使用 Docker 时，推荐使用项目自带的 [原生 faster-whisper HTTP 服务](local-asr/README.md)。插件界面已统一称为「语音识别服务」，Speaches 的地址和配置方式仍然有效。

插件不内置语音识别模型。Speaches 负责将音频转成文字，插件负责采集标签页声音、显示字幕，并调用已有翻译引擎。YouTube / B 站已有字幕功能不需要这个服务。

## Windows：Docker Desktop 部署示例

先安装并启动支持 Linux 容器的 Docker Desktop。下面以 CPU 版本为例，在 PowerShell 执行：

```powershell
docker run -d --name speaches -p 127.0.0.1:8000:8000 -v speaches-models:/home/ubuntu/.cache/huggingface/hub ghcr.io/speaches-ai/speaches:latest-cpu
```

端口仅绑定本机，模型缓存保存在 Docker 卷。查看服务启动状态：

```powershell
docker logs -f speaches
```

停止查看日志可按 Ctrl+C，不会停止容器。之后可用 `docker stop speaches` 停止、`docker start speaches` 启动已有容器，不必重复执行创建命令。

需要 NVIDIA GPU 加速时，按 [Speaches 官方安装文档](https://speaches.ai/installation/) 使用 CUDA 镜像及 GPU 参数；CPU 是否能跟上视频播放取决于模型和电脑性能。

## 下载识别模型

安装 uv 后，在 PowerShell 中使用 Speaches 官方 CLI：

```powershell
$env:SPEACHES_BASE_URL = 'http://127.0.0.1:8000'
uvx speaches-cli model download Systran/faster-whisper-small
```

等待下载完成后再开启听译。模型下载需要能访问模型托管服务。多语言识别请使用多语言模型，不要选择 `.en` 英语专用模型；性能不足可以部署更小的多语言模型，并在插件中填写它的完整 ID。

模型管理方式以部署版本的 [官方 Speech-to-Text 文档](https://speaches.ai/usage/speech-to-text/) 为准。插件的「获取已安装模型」只读取 `/v1/models`，不会下载或自动选择模型，列表中可能包含非语音识别模型。

## 插件配置

| 设置 | 示例 |
| --- | --- |
| Speaches 基础地址 | `http://127.0.0.1:8000/v1` |
| API Key | 未启用认证时留空；如服务设置了认证则填写其 Key |
| 模型 ID | `Systran/faster-whisper-small` |
| 原语言 | 自动识别，或者手动指定 |
| 音频分段 | 先使用默认 2 秒（停顿时提前发送） |
| 翻译引擎 | Microsoft / Google / 已配置的 OpenAI、Anthropic；或只识别 |

插件以 multipart POST 发送 WAV 文件到 `/v1/audio/transcriptions`，包含 `model`、`response_format=verbose_json`，手动指定语言时另带 `language`。服务应返回 `text`，也支持读取 `segments` 和 `language`；可选 Key 使用 Bearer 认证。

识别服务不是聊天模型服务。不要将只支持 `/chat/completions` 的地址填到 Speaches 地址中。转写之后使用的翻译模型仍在原来的「翻译引擎设置」中配置。

## 常见问题

- **连接失败**：确认容器已启动、端口为 8000，地址包含 `/v1`，并已允许插件访问该地址。
- **401**：检查 Speaches 的认证配置及 Key。
- **404 / 模型不存在**：确认模型已下载，ID 与服务一致；不要只填 `whisper`。
- **首次识别超时**：模型首次加载可能较慢，查看服务日志，确认模型就绪后重试。
- **字幕跟不上**：先选择「只识别」区分瓶颈；识别慢可换小模型或 GPU，翻译慢可切换引擎。分段越短请求越频繁，不一定总是更快。
- **浏览器拒绝采集**：回到目标视频页，点击工具栏插件按钮，再打开通用听译；目标网页更新插件后需刷新。
- **需要完全本地处理**：将翻译引擎也配置成本地兼容接口。选择远程翻译引擎时，转写文字会发送给该服务。

此部署示例根据 Speaches 官方文档整理；本次未替用户安装 Docker、下载模型、启动服务或执行测试。

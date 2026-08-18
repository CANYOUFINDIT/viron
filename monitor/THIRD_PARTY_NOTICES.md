# viron-monitor 第三方组件

`viron-monitor-collector` 固定使用 InfluxData Telegraf `v1.39.2` 的 CPU、内存、系统、磁盘、传感器、systemd、Docker/Podman 和 Supervisor 输入插件。Telegraf 使用 MIT License：<https://github.com/influxdata/telegraf/blob/v1.39.2/LICENSE>。

Kubernetes kubeconfig 解析、认证和 API 访问使用 Kubernetes `client-go`、`api` 与 `apimachinery` `v0.36.2`。这些组件使用 Apache License 2.0：<https://github.com/kubernetes/client-go/blob/v0.36.2/LICENSE>。

`viron-monitor` 使用 modernc.org/sqlite 提供不依赖 CGO 的 SQLite/WAL 本地缓冲。其许可证及依赖许可证随 Go module 源码和构建产物的发布清单一并保留。

Viron 对上述组件的使用范围限定在指标采集和本地持久化。服务候选归一化、SSH 拉取、确认游标、缺口记录和中心入库协议属于 Viron 自身实现。

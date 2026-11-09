using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace UkagakaBangumi
{
    // One asynchronous startup per desktop pet. The private input pipe owns its child process.
    internal sealed class PanelHost : IDisposable
    {
        readonly string _root;
        readonly string _instance;
        readonly Action<string> _log;
        readonly object _gate = new object();
        Task<int> _startup;
        Process _owned;
        bool _disposed;

        public PanelHost(string root, Action<string> log)
        {
            _root = root;
            _instance = Id(root);
            _log = log;
        }

        public static string Id(string root)
        {
            string name = Path.GetFullPath(root).Replace('\\', '/').TrimEnd('/').ToLowerInvariant();
            using (var sha = SHA256.Create())
                return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(name))).Replace("-", "").ToLowerInvariant();
        }

        public static string Runtime(string root)
        {
            string local = Path.Combine(root, "runtime", "node.exe");
            return File.Exists(local) ? local : "node.exe";
        }

        public Task<int> EnsureStarted()
        {
            lock (_gate)
            {
                if (_disposed) throw new ObjectDisposedException("PanelHost");
                if (_startup == null || _startup.IsCompleted)
                    _startup = Task.Factory.StartNew<int>(Start, CancellationToken.None, TaskCreationOptions.None, TaskScheduler.Default);
                return _startup;
            }
        }

        int Find()
        {
            int port;
            try
            {
                if (!int.TryParse(File.ReadAllText(Path.Combine(_root, "cache", "panel_port.txt")), out port)
                    || port < 1 || port > 65535) return 0;
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/health");
                req.Proxy = null;
                req.AllowAutoRedirect = false;
                req.Timeout = 400;
                req.ReadWriteTimeout = 400;
                using (var response = (HttpWebResponse)req.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    var json = new JavaScriptSerializer { MaxJsonLength = 4096 }.DeserializeObject(reader.ReadToEnd());
                    var fields = json as System.Collections.Generic.Dictionary<string, object>;
                    object app, instance, actual;
                    if (fields != null && fields.TryGetValue("app", out app) && (app as string) == "tiara"
                        && fields.TryGetValue("instance", out instance) && (instance as string) == _instance
                        && fields.TryGetValue("port", out actual) && Convert.ToInt32(actual) == port) return port;
                }
            }
            catch { }
            return 0;
        }

        int Start()
        {
            int existing = Find();
            if (existing != 0) return existing;

            lock (_gate)
            {
                if (_disposed) throw new ObjectDisposedException("PanelHost");
                if (_owned == null || _owned.HasExited)
                {
                    if (_owned != null) _owned.Dispose();
                    _owned = null;
                    string script = Path.Combine(_root, "server.mjs");
                    if (!File.Exists(script)) throw new InvalidOperationException("找不到网页服务文件，请重新解压完整便携包。");
                    var child = new Process();
                    child.StartInfo = new ProcessStartInfo(Runtime(_root), "\"" + script + "\" --managed")
                    {
                        WorkingDirectory = _root,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardInput = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        StandardOutputEncoding = Encoding.UTF8,
                        StandardErrorEncoding = Encoding.UTF8
                    };
                    child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) _log("panel: " + e.Data); };
                    child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) _log("panel error: " + e.Data); };
                    try { child.Start(); }
                    catch (System.ComponentModel.Win32Exception e)
                    {
                        child.Dispose();
                        _log("panel start failed: " + e.Message);
                        throw new InvalidOperationException("网页运行时无法启动，请重新解压完整便携包。", e);
                    }
                    _owned = child;
                    child.BeginOutputReadLine();
                    child.BeginErrorReadLine();
                }
            }

            var wait = Stopwatch.StartNew();
            while (wait.ElapsedMilliseconds < 10000)
            {
                int port = Find();
                if (port != 0) return port;
                lock (_gate)
                {
                    if (_disposed) throw new ObjectDisposedException("PanelHost");
                    if (_owned.HasExited) break;
                }
                Thread.Sleep(125);
            }
            throw new InvalidOperationException("网页服务没有启动成功。请查看服务日志，再点「打开网页番组表」重试。");
        }

        public void Dispose()
        {
            lock (_gate)
            {
                _disposed = true;
                if (_owned == null) return;
                try { _owned.StandardInput.Close(); } catch { }
                _owned.Dispose();
                _owned = null;
            }
        }
    }
}

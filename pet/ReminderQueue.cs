using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;

namespace UkagakaBangumi
{
    public partial class PetWindow
    {
        public sealed class SnoozeItem
        {
            public string key { get; set; }
            public string id { get; set; }
            public string kind { get; set; }
            public string name { get; set; }
            public string status { get; set; }
            public long due_at { get; set; }
        }

        public sealed class SnoozeResponse
        {
            public bool ok { get; set; }
            public List<SnoozeItem> pending { get; set; }
            public List<SnoozeItem> claimed { get; set; }
        }

        bool _snoozeClaimPending;
        Window _snoozesWindow;

        bool HasDueSnoozes(long now)
        {
            try
            {
                string file = Path.Combine(_root, "data", "reminder-snoozes.json");
                using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var reader = new StreamReader(stream, Encoding.UTF8))
                {
                    var rows = new JavaScriptSerializer().Deserialize<List<SnoozeItem>>(reader.ReadToEnd());
                    return rows != null && rows.Exists(row => row != null && row.status == "pending" && row.due_at <= now);
                }
            }
            catch { return false; }
        }

        void CallSnoozes(object request, Action<SnoozeResponse> done)
        {
            if (_selfTest || _closing) { done(null); return; }
            UsePanel(port =>
            {
                var url = "http://127.0.0.1:" + port + "/api/reminder/snoozes";
                Action<string> respond = raw =>
                {
                    SnoozeResponse result = null;
                    if (raw != null) try { result = new JavaScriptSerializer().Deserialize<SnoozeResponse>(raw); } catch {}
                    done(result);
                };
                if (request != null)
                    PostJsonAsync(url, new JavaScriptSerializer().Serialize(request), respond);
                else ThreadPool.QueueUserWorkItem(delegate
                {
                    string raw = null;
                    try
                    {
                        var req = (HttpWebRequest)WebRequest.Create(url);
                        req.Proxy = null;
                        req.Timeout = 5000;
                        req.ReadWriteTimeout = 3000;
                        using (var response = (HttpWebResponse)req.GetResponse())
                        using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                            raw = reader.ReadToEnd();
                    }
                    catch (Exception ex) { Log("snooze list: " + ex.Message); }
                    if (!_closing) Dispatcher.BeginInvoke(new Action(() => respond(raw)));
                });
            }, false, () => done(null));
        }

        void OpenReminderSnoozes()
        {
            if (_snoozesWindow != null) { _snoozesWindow.Activate(); return; }
            StackPanel content;
            var win = UtilityWindow("TIARA · 稍后提醒", out content);
            _snoozesWindow = win;
            win.Closed += delegate { _snoozesWindow = null; };
            UtilityText(content, "待生效的稍后提醒", true);
            UtilityText(content, "番剧暂停、完结或改期时，旧档位的稍后提醒会失效。时间为北京时间。");
            var list = new StackPanel();
            content.Children.Add(list);
            Action<SnoozeResponse> render = null;
            Action<object> request = action =>
            {
                list.Children.Clear();
                UtilityText(list, "正在读取稍后提醒…");
                CallSnoozes(action, result => { if (_snoozesWindow == win) render(result); });
            };
            render = result =>
            {
                list.Children.Clear();
                if (result == null || !result.ok) { UtilityText(list, "无法确认。若原排期已改动，该提醒可能已失效。请刷新。"); return; }
                if (result.pending == null || result.pending.Count == 0) UtilityText(list, "没有待生效的稍后提醒。");
                else foreach (var item in result.pending)
                {
                    string key = item.key;
                    UtilityText(list, item.name + " · " + ReminderLocalTime(item.due_at).ToString("MM-dd HH:mm", CultureInfo.InvariantCulture));
                    var actions = new WrapPanel();
                    list.Children.Add(actions);
                    UtilityButton(actions, "15 分钟后", "snooze-15", () => request(new { action = "delay", key, minutes = 15 }));
                    UtilityButton(actions, "30 分钟后", "snooze-30", () => request(new { action = "delay", key, minutes = 30 }));
                    UtilityButton(actions, "取消提醒", "snooze-cancel", () => request(new { action = "cancel", key }));
                }
            };
            var footer = new WrapPanel();
            content.Children.Add(footer);
            UtilityButton(footer, "刷新", "snooze-refresh", () => request(null));
            UtilityButton(footer, "关闭", "snooze-close", () => win.Close());
            win.Show();
            request(null);
        }
    }
}

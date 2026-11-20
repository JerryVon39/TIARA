using System;
using System.Collections.Generic;
using System.IO;
using System.Globalization;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Threading;

namespace UkagakaBangumi
{
    public partial class PetWindow
    {
        const int ReminderHistoryLimit = 200;
        List<ReminderRecord> _reminderHistory;
        long _reminderScannedAt, _lastReminderTick, _lastReminderSummary;
        bool _recoverReminders = true, _reminderRefreshPending;

        static DateTime ReminderLocalTime(long at)
        {
            return new DateTime(1970, 1, 1).AddSeconds(at).AddHours(8);
        }

        static string ReminderDate(long at) { return ReminderLocalTime(at).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture); }

        IntPtr ReminderPowerHook(IntPtr window, int message, IntPtr eventId, IntPtr data, ref bool handled)
        {
            const int WM_POWERBROADCAST = 0x218, PBT_APMRESUMEAUTOMATIC = 0x12;
            if (message == WM_POWERBROADCAST && eventId.ToInt64() == PBT_APMRESUMEAUTOMATIC && !_closing && !_selfTest)
            {
                Log("system resume: checking missed reminders");
                _recoverReminders = true;
                Dispatcher.BeginInvoke(DispatcherPriority.Normal, new Action(CheckReminders));
            }
            return IntPtr.Zero;
        }

        void RefreshReminderSnapshot()
        {
            if (_selfTest || _reminderRefreshPending) return;
            _reminderRefreshPending = true;
            RefreshDataAsync(false, delegate (bool ok)
            {
                _reminderRefreshPending = false;
                if (ok && !_closing)
                {
                    long now = UnixNow();
                    if (V("date", "") == ReminderDate(now) &&
                        (!_recoverReminders || V("previous_date", "") == ReminderDate(now - 86400)) &&
                        ReadActiveWatchIds() != null) CheckReminders();
                }
            });
        }

        void ReadReminderSlots(List<ReminderCandidate> due, string prefix, int count, long from, long now, int lead)
        {
            for (int i = 1; i <= count; i++)
            {
                string row = prefix + i;
                long at;
                if (!long.TryParse(V(row + "_unix", ""), out at) || at <= 0) continue;
                long fire;
                if (I("reminder_lead") != lead || !long.TryParse(V(row + "_fire_unix", ""), out fire))
                    fire = at - lead * 60L;
                if (fire < from || fire > now) continue;
                string id = V(row + "_id", "");
                if (string.IsNullOrEmpty(id)) continue;
                bool personal = prefix == "personal" || V(row + "_personal", "") == "1";
                string name = V(row + "_name", "这一部");
                string date = ReminderDate(at);
                string key = date + "|" + (personal ? "catchup|" : "") + id + "|" + at;
                if (_reminded.Contains(key) || (!personal && _reminded.Contains(date + "|" + name)) ||
                    due.Exists(item => item.Key == key)) continue;
                due.Add(new ReminderCandidate { Id = id, Key = key, At = at, FireAt = fire, Name = name, Personal = personal,
                    Stamp = V(row + "_stamp", ""),
                    Time = V(row + "_time_disp", V(row + "_time", "--:--")), Eps = V(row + "_eps", "") });
            }
        }

        void ShowMissedReminders(List<ReminderCandidate> due)
        {
            _lastReminderSummary = UnixNow();
            foreach (var item in due) item.Recovered = true;
            due.Sort((a, b) => a.At.CompareTo(b.At));
            var lines = due.GetRange(0, Math.Min(4, due.Count)).ConvertAll(item =>
                ReminderLocalTime(item.At).ToString("MM-dd HH:mm", CultureInfo.InvariantCulture) + " " +
                (item.Personal ? "补番" : item.Snoozed ? "稍后" : "开播") + " · " + item.Name);
            string message = "恢复后补发 " + due.Count + " 条提醒\n" + string.Join("\n", lines);
            if (due.Count > lines.Count) message += "\n其余可在提醒记录查看。";
            bool bubble = ReminderCanSpeak && !AmbientQuiet;
            if (bubble)
            {
                CancelSequence();
                SayWithChoices(new Line(message, 1),
                    new Choice("查看提醒记录", () => { RecordReminders(due, null, action: "history_opened"); OpenWebPanel("?reminders=1"); }),
                    new Choice("知道了", () => RecordReminders(due, null, action: "acknowledged")));
            }
            PublishReminders(due, "TIARA · 错过提醒摘要", message, bubble);
        }

        public sealed class ReminderRecord
        {
            public string key { get; set; }
            public string kind { get; set; }
            public string watch_id { get; set; }
            public string name { get; set; }
            public long scheduled_at { get; set; }
            public long recorded_at { get; set; }
            public string status { get; set; }
            public bool bubble { get; set; }
            public bool recovered { get; set; }
            public string action { get; set; }
            public long? action_at { get; set; }
            public long? snoozed_until { get; set; }
            public string source_stamp { get; set; }
        }

        void RecordReminders(IEnumerable<ReminderCandidate> items, string status, bool bubble = false,
            string action = null, long? snoozedUntil = null)
        {
            if (_selfTest || _closing) return;
            string file = Path.Combine(_root, "data", "reminder-history.json");
            try
            {
                if (_reminderHistory == null)
                    _reminderHistory = File.Exists(file)
                        ? new JavaScriptSerializer().Deserialize<List<ReminderRecord>>(File.ReadAllText(file, Encoding.UTF8))
                        : new List<ReminderRecord>();
                if (_reminderHistory == null) _reminderHistory = new List<ReminderRecord>();
                var next = new List<ReminderRecord>(_reminderHistory);
                bool changed = false;
                long now = UnixNow();
                foreach (var item in items)
                {
                    var old = next.Find(entry => entry != null && entry.key == item.Key);
                    if (old != null && (action != null ? old.action == action : old.status == status ||
                        old.status == "requested" || old.status == "unavailable")) continue;
                    if (old != null) next.Remove(old);
                    next.Insert(0, new ReminderRecord
                    {
                        key = item.Key, kind = item.Test ? "test" : item.Snoozed ? "snooze" : item.Personal ? "catchup" : "airing",
                        watch_id = item.Id, name = item.Name, scheduled_at = item.At,
                        recorded_at = action == null || old == null ? now : old.recorded_at,
                        status = status ?? (old == null ? null : old.status),
                        bubble = action == null || old == null ? bubble : old.bubble,
                        recovered = item.Recovered || (old != null && old.recovered),
                        action = action, action_at = action == null ? (long?)null : now, snoozed_until = snoozedUntil,
                        source_stamp = item.Stamp
                    });
                    changed = true;
                }
                if (!changed) return;
                if (next.Count > ReminderHistoryLimit) next.RemoveRange(ReminderHistoryLimit, next.Count - ReminderHistoryLimit);
                WritePetJson(file, next);
                _reminderHistory = next;
            }
            catch (Exception ex) { Log("reminder history: " + ex.Message); }
        }

        void PublishReminders(List<ReminderCandidate> due, string title, string message, bool bubble)
        {
            RecordReminders(due, Notify(title, message) ? "requested" : "unavailable", bubble);
        }
    }
}

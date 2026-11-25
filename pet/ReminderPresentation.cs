using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Web.Script.Serialization;

namespace UkagakaBangumi
{
    public partial class PetWindow
    {
        const long ReminderWindowSeconds = 6 * 3600;
        readonly List<ReminderCandidate> _pendingReminders = new List<ReminderCandidate>();
        readonly List<QuietPeriod> _quietPeriods = new List<QuietPeriod>();
        bool _bubbleIsReminder;
        int _snoozeSettingsPending;

        public sealed class QuietPeriod
        {
            public long Start { get; set; }
            public long End { get; set; }
        }

        void LoadQuietPeriods(JavaScriptSerializer serializer, Dictionary<string, object> state)
        {
            long now = UnixNow();
            var stored = StateValue<List<QuietPeriod>>(serializer, state, "quiet_periods");
            if (stored != null)
                _quietPeriods.AddRange(stored.Where(period => period != null && period.Start > 0 && period.Start < period.End &&
                    period.End > now - ReminderWindowSeconds && period.End <= UnixTimeLimit));
            // 旧版只保存结束时间，能确定的是结束前至少有 15 分钟处于临时安静。
            if (_quietUntil > now - ReminderWindowSeconds && _quietUntil <= UnixTimeLimit &&
                !_quietPeriods.Exists(period => period.End == _quietUntil))
                _quietPeriods.Add(new QuietPeriod { Start = _quietUntil - 15 * 60, End = _quietUntil });
        }

        void SetTemporaryQuiet(int minutes, long now)
        {
            _quietPeriods.RemoveAll(period => period.End <= now - ReminderWindowSeconds);
            var current = _quietPeriods.FindLast(period => period.Start <= now && now < period.End);
            if (minutes == 0)
            {
                if (current != null) current.End = now;
                _quietUntil = 0;
            }
            else
            {
                _quietUntil = now + minutes * 60L;
                if (current != null) current.End = _quietUntil;
                else _quietPeriods.Add(new QuietPeriod { Start = now, End = _quietUntil });
            }
        }

        static string ReminderClock(long at)
        {
            return ReminderLocalTime(at).ToString("MM-dd HH:mm", CultureInfo.InvariantCulture);
        }

        void LoadPendingReminders(JavaScriptSerializer serializer, Dictionary<string, object> state)
        {
            var stored = StateValue<List<ReminderCandidate>>(serializer, state, "pending_reminders");
            if (stored == null) return;
            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in stored)
            {
                if (item == null || string.IsNullOrEmpty(item.Id) || string.IsNullOrEmpty(item.Key) ||
                    item.At <= 0 || item.At > UnixTimeLimit || item.FireAt <= 0 || item.FireAt > UnixTimeLimit ||
                    !keys.Add(item.Key)) continue;
                item.Recovered = true;
                _pendingReminders.Add(item);
            }
        }

        const long UnixTimeLimit = 253402185599L; // 北京时间仍可表示的最大 Unix 秒

        string ReminderQuietStatus(Dictionary<string, object> settings, long now, long fire)
        {
            string rule = ReminderQuietRule(settings, fire) ?? ReminderQuietRule(settings, now);
            if (rule != null) return rule;
            return _quietUntil > now || _quietPeriods.Any(period => period.Start <= fire && fire < period.End)
                ? "temporary_quiet" : null;
        }

        bool UpdateQueuedReminderTimes(int lead, Dictionary<string, Dictionary<string, object>> active)
        {
            var changes = new Dictionary<ReminderCandidate, long>();
            foreach (var item in _pendingReminders)
            {
                if (item.Snoozed) continue;
                Dictionary<string, object> entry;
                long fire = ReminderFireAt(item.At, active.TryGetValue(item.WatchKey, out entry) ? ReadReminderLead(entry, lead) : lead);
                if (fire == item.FireAt) continue;
                changes.Add(item, item.FireAt);
                item.FireAt = fire;
            }
            if (changes.Count == 0 || _selfTest || SaveState()) return true;
            foreach (var change in changes) change.Key.FireAt = change.Value;
            return false;
        }

        bool ReminderOccurrenceCurrent(ReminderCandidate item)
        {
            if (string.IsNullOrEmpty(item.Stamp)) return true; // 兼容升级前缓存生成的提醒
            long slot = item.Snoozed ? item.OriginalAt : item.At;
            foreach (string prefix in new[] { "show", "personal", "previous", "next" })
            {
                int count = I(prefix == "show" ? "count" : prefix + "_count");
                for (int i = 1; i <= count; i++)
                {
                    string row = prefix + i;
                    bool personal = prefix == "personal" || V(row + "_personal", "") == "1";
                    long at;
                    if (personal == item.Personal && V(row + "_id", "") == item.Id &&
                        V(row + "_stamp", "") == item.Stamp &&
                        long.TryParse(V(row + "_unix", ""), out at) && at == slot) return true;
                }
            }
            return false;
        }

        void TryPresentReminders(long now)
        {
            if (_pendingReminders.Count == 0 || _closing || !_locationReady) return;
            var settings = ReadReminderSettings();
            var blocked = new Dictionary<string, string>();
            var active = ReadReminderTargets(blocked);
            if (active == null) { RefreshReminderSnapshot(); return; }
            if (!UpdateQueuedReminderTimes(ReadReminderLead(settings), active)) return;
            var expired = _pendingReminders.FindAll(item => now - item.FireAt > ReminderWindowSeconds);
            if (expired.Count > 0)
            {
                foreach (var item in expired) _pendingReminders.Remove(item);
                if (!_selfTest && !SaveState())
                {
                    _pendingReminders.AddRange(expired);
                    return;
                }
                RecordReminders(expired, "expired");
                if (_pendingReminders.Count == 0) return;
            }
            bool quiet = _quietUntil > now || ReminderQuiet(settings, now);
            bool bubble = ReminderCanSpeak;
            if (!quiet && (FocusActive || (IsVisible && !_reminderTrayOnly && !bubble))) return;
            // The snapshot may still be from before midnight or before the latest library write.
            if (V("date", "") != ReminderDate(now) || V("previous_date", "") != ReminderDate(now - 86400))
            {
                RefreshReminderSnapshot();
                return;
            }
            var due = _pendingReminders.Where(item => item.FireAt <= now).OrderBy(item => item.FireAt).ToList();
            if (due.Count == 0) return;
            var first = due[0];
            var batch = due.Where(item => item.Recovered == first.Recovered &&
                (first.Recovered || item.FireAt / 60 == first.FireAt / 60))
                .Take(40).ToList();
            foreach (var item in batch) _pendingReminders.Remove(item);
            if (!_selfTest && !SaveState())
            {
                _pendingReminders.AddRange(batch);
                return;
            }

            var show = new List<ReminderCandidate>();
            foreach (var item in batch)
            {
                string status = !active.ContainsKey(item.WatchKey) || !ReminderOccurrenceCurrent(item) ? BlockedReminderReason(blocked, item.Id) :
                    ReminderQuietStatus(settings, now, item.FireAt);
                if (status == null)
                {
                    item.Episode = ReminderEpisode(active[item.WatchKey]);
                    show.Add(item);
                }
                else RecordSkippedReminders(new[] { item }, status);
            }
            if (show.Count > 0) PresentReminderBatch(show, active, now, bubble);
        }

        static string BlockedReminderReason(Dictionary<string, string> blocked, string id)
        {
            string reason;
            return blocked.TryGetValue(id, out reason) ? reason : "schedule_changed";
        }

        void RecordSkippedReminders(IEnumerable<ReminderCandidate> items, string reason)
        {
            string status = reason == "quiet_work" || reason == "quiet_weekend" ? "quiet" :
                reason == "temporary_quiet" || reason == "merged" ? reason : "inactive";
            RecordReminders(items, status, reason: reason);
        }

        static int ReminderInt(Dictionary<string, object> entry, string key)
        {
            object value;
            int number;
            return entry.TryGetValue(key, out value) && int.TryParse(Str(value), out number) ? Math.Max(0, number) : 0;
        }

        static int ReminderEpisode(Dictionary<string, object> entry)
        {
            int next = Math.Max(ReminderInt(entry, "ep_status"), ReminderInt(entry, "start_episode") - 1) + 1;
            object value;
            var extras = entry.TryGetValue("episode_extras", out value) ? AsList(value) : null;
            if (extras != null)
            {
                var watched = new HashSet<string>(extras.Select(Str));
                while (next > 0 && next <= 10000 && watched.Contains(next.ToString(CultureInfo.InvariantCulture))) next++;
            }
            int total = ReminderInt(entry, "eps");
            return next > 0 && next <= 10000 && (total == 0 || next <= total) ? next : 0;
        }

        const int DefaultSnoozeMinutes = 15;

        sealed class ReminderReviewRow
        {
            public ReminderCandidate Item;
            public string ViewLabel;
            public string Status;
            public bool Busy, Handled;
            public SnoozeUndoReceipt Undo;
            public bool CanSnooze { get { return !Item.Snoozed && !string.IsNullOrEmpty(Item.Stamp); } }
        }

        static string ReminderItemTitle(ReminderCandidate item)
        {
            return item.Name + (item.Episode > 0 ? " · 待看第 " + item.Episode + " 集" : "");
        }

        static string ReminderItemTime(ReminderCandidate item)
        {
            return "提醒 " + ReminderClock(item.FireAt) +
                (item.Snoozed || item.FireAt == item.At ? "" : " · " + (item.Personal ? "补番 " : "排片 ") + ReminderClock(item.At));
        }

        static string ReminderViewingUrl(Dictionary<string, object> entry)
        {
            bool backup;
            return PlaybackFromEntry(entry, out backup);
        }

        void PresentReminderBatch(List<ReminderCandidate> show, Dictionary<string, Dictionary<string, object>> active, long now, bool bubble)
        {
            bool recovered = show.Any(item => item.Recovered);
            if (recovered) _lastReminderSummary = now;
            var first = show[0];
            string heading = recovered ? "错过提醒摘要" : show.Count > 1 ? "观看提醒" :
                first.Snoozed ? "稍后提醒" : first.Personal ? "补番提醒" : "开播提醒";
            string message = show.Count == 1
                ? ReminderItemTitle(first) + "\n" + ReminderItemTime(first)
                : show.Count + " 部番剧待处理\n" + string.Join("、", show.Take(2).Select(item => item.Name)) +
                    (show.Count > 2 ? " 等" : "");
            if (bubble)
            {
                if (show.Count == 1) ShowSingleReminder(new ReminderReviewRow
                {
                    Item = first, ViewLabel = ReminderViewingUrl(active[first.WatchKey]) == null ? "查看番剧" : "去观看"
                }, heading);
                else SayChoices(new Line(message, 1), heading, new Choice("逐部处理", OpenReminderCenter));
                PublishReminders(show, "TIARA · " + heading, message, true);
                return;
            }

            PublishReminders(show, "TIARA · " + heading, message + "\n点通知或从托盘处理。", false, OpenReminderCenter);
        }

        void ShowSingleReminder(ReminderReviewRow row, string heading)
        {
            var item = row.Item;
            var choices = new List<Choice> { new Choice(row.ViewLabel, () => ViewReminder(row)) };
            if (row.CanSnooze)
                choices.Add(new Choice("稍后 15 分钟", () => SnoozeReminder(row, DefaultSnoozeMinutes,
                    () => ShowSnoozeFeedback(row, heading))));
            choices.Add(new Choice("更多", () => OpenReminderCenter("pending", item.Key)));
            SayChoices(new Line(ReminderItemTitle(item) + "\n" + ReminderItemTime(item), 1), heading, choices.ToArray());
        }

        void ViewReminder(ReminderReviewRow row)
        {
            var item = row.Item;
            var current = ReadReminderTargets();
            Dictionary<string, object> entry;
            var url = current != null && current.TryGetValue(item.WatchKey, out entry) ? ReminderViewingUrl(entry) : null;
            RecordReminders(new[] { item }, null, action: url == null ? "details_opened" : "watch_clicked");
            if (url != null) OpenViewingLink(url);
            else OpenWebPanel("?watch=" + Uri.EscapeDataString(item.Id));
        }

        void ShowSnoozeFeedback(ReminderReviewRow row, string heading)
        {
            if (_closing) return;
            if (!IsVisible)
            {
                OpenReminderCenter(row.Handled ? "snoozes" : "pending", row.Handled ? null : row.Item.Key);
                return;
            }
            var choices = new List<Choice>();
            if (row.Undo != null) choices.Add(new Choice("撤销延后", () => UndoReminderSnooze(row, () =>
            {
                if (_closing) return;
                if (!row.Handled && IsVisible) ShowSingleReminder(row, heading);
                else ShowSnoozeFeedback(row, heading);
            })));
            choices.Add(row.Handled
                ? new Choice("查看稍后提醒", OpenReminderSnoozes)
                : new Choice("返回提醒", () => ShowSingleReminder(row, heading)));
            SayChoices(new Line(row.Status, row.Handled ? 1 : 2), "稍后提醒", choices.ToArray());
        }

        void OpenReminderCenter()
        {
            OpenReminderCenter("pending", null);
        }

        void OpenReminderCenter(string tab, string key)
        {
            OpenWebPanel("?reminders=" + tab + (string.IsNullOrEmpty(key) ? "" : "&event=" + Uri.EscapeDataString(key)));
        }

        void SnoozeReminder(ReminderReviewRow row, int minutes, Action update)
        {
            if (row.Handled || row.Busy) return;
            var item = row.Item;
            string kind = item.Personal ? "catchup" : "airing";
            row.Busy = true;
            row.Status = "正在安排稍后提醒…";
            _snoozeSettingsPending++;
            CallSnoozes(new { action = "create", event_key = item.Key, minutes, items = new[] { new
            {
                id = item.Id, kind, slot_at = item.At, stamp = item.Stamp
            } } }, result =>
            {
                _snoozeSettingsPending--;
                row.Busy = false;
                var match = result == null || !result.ok || result.pending == null ? null :
                    result.pending.Find(entry => entry.id == item.Id && entry.kind == kind && entry.slot_at == item.At && entry.stamp == item.Stamp);
                if (match == null)
                    row.Status = (result == null ? null : result.error) ?? "暂时无法安排稍后提醒，请重试。";
                else
                {
                    row.Handled = true;
                    row.Undo = result.created == null ? null : result.created.Find(receipt => receipt.key == match.key);
                    row.Status = (row.Undo == null ? "已安排在 " : "已延后至 ") + ReminderClock(match.due_at) + "（北京时间）";
                    RecordReminders(new[] { item }, null, action: "snoozed", snoozedUntil: match.due_at);
                }
                update();
            });
        }

        void UndoReminderSnooze(ReminderReviewRow row, Action update)
        {
            if (row.Undo == null || row.Busy) return;
            var receipt = row.Undo;
            row.Busy = true;
            row.Status = "正在撤销延后…";
            _snoozeSettingsPending++;
            CallSnoozes(new { action = "undo_create", receipt.key, receipt.token }, result =>
            {
                _snoozeSettingsPending--;
                row.Busy = false;
                if (result != null && result.ok)
                {
                    row.Handled = false;
                    row.Undo = null;
                    row.Status = "已撤销延后";
                    RecordReminders(new[] { row.Item }, null, action: "snooze_undone");
                }
                else
                {
                    if (result != null) row.Undo = null;
                    row.Status = (result == null ? null : result.error) ?? "暂时无法撤销，请重试。";
                }
                update();
            });
        }

    }
}

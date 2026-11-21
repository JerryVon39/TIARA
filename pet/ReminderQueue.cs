using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

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
            public string stamp { get; set; }
            public long due_at { get; set; }
            public long slot_at { get; set; }
            public long lease_until { get; set; }
            public string claim_token { get; set; }
        }

        public sealed class SnoozeResponse
        {
            public bool ok { get; set; }
            public string error { get; set; }
            public List<SnoozeItem> pending { get; set; }
            public List<SnoozeItem> claimed { get; set; }
            public List<SnoozeUndoReceipt> created { get; set; }
        }

        public sealed class SnoozeUndoReceipt
        {
            public string key { get; set; }
            public string token { get; set; }
        }

        bool _snoozeClaimPending;

        bool HasDueSnoozes(long now)
        {
            try
            {
                string file = Path.Combine(_root, "data", "reminder-snoozes.json");
                using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var reader = new StreamReader(stream, Encoding.UTF8))
                {
                    var rows = new JavaScriptSerializer().Deserialize<List<SnoozeItem>>(reader.ReadToEnd());
                    return rows != null && rows.Exists(row => row != null && row.status == "pending" &&
                        row.due_at <= now && row.lease_until <= now);
                }
            }
            catch { return false; }
        }

        string SnoozeDeliveryKey(SnoozeItem item)
        {
            return ReminderDate(item.due_at) + "|snooze|" + item.key;
        }

        void ConfirmSnoozes(List<SnoozeItem> snoozes)
        {
            if (snoozes == null || snoozes.Count == 0) return;
            var items = snoozes.ConvertAll(item => new { item.key, item.claim_token });
            CallSnoozes(new { action = "ack", items }, result =>
            {
                if (result == null || !result.ok) Log("snooze ack failed; will confirm the next claim");
            });
        }

        void CallSnoozes(object request, Action<SnoozeResponse> done)
        {
            if (_selfTest || _closing) { done(null); return; }
            UsePanel(port =>
            {
                var url = "http://127.0.0.1:" + port + "/api/reminder/snoozes";
                var serializer = new JavaScriptSerializer();
                PostJsonAsync(url, serializer.Serialize(request), raw =>
                {
                    SnoozeResponse result = null;
                    if (raw != null) try { result = serializer.Deserialize<SnoozeResponse>(raw); } catch {}
                    done(result);
                }, readConflict: true);
            }, false, () => done(null));
        }

        void OpenReminderSnoozes()
        {
            OpenReminderCenter("snoozes", null);
        }
    }
}

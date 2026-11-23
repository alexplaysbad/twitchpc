using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace TwitchPC
{
    internal sealed class Field
    {
        public string Key { get; private set; }
        public string Label { get; private set; }
        public bool Secret { get; private set; }

        public Field(string key, string label, bool secret = false)
        {
            Key = key;
            Label = label;
            Secret = secret;
        }
    }

    internal static class TrayApp
    {
        private static readonly Field[] Fields = new[]
        {
            new Field("CLOUD_URL", "Cloud URL (wss://.../agent)"),
            new Field("AGENT_ID", "Agent ID"),
            new Field("PAIRING_CODE", "Pairing code (one-time, optional)"),
            new Field("AGENT_TOKEN", "Agent token (saved after pairing)", true),
            new Field("AGENT_CONTROL_PORT", "Local control port (default 4310)"),
            new Field("EXEC_ALLOWLIST", "Allowed executables (comma-separated)"),
            new Field("OBS_WS_URL", "OBS WebSocket URL"),
            new Field("OBS_PASSWORD", "OBS password", true),
            new Field("HEARTBEAT_INTERVAL_MS", "Heartbeat interval (ms)"),
            new Field("RECONNECT_DELAY_MS", "Reconnect delay (ms)"),
            new Field("AGENT_AUTO_UPDATE", "Auto-update (true/false)")
        };

        private static NotifyIcon tray;
        private static ContextMenuStrip menu;
        private static ToolStripMenuItem pauseItem;
        private static Timer timer;
        private static Process agentProcess;

        private static string root;
        private static string coreExe;
        private static string envPath;
        private static int controlPort;
        private static bool stopping;
        private static bool pairPromptOpen;
        private static DateTime suppressUntil = DateTime.MinValue;
        private static DateTime pairingSuppressedUntil = DateTime.MinValue;

        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            root = AppDomain.CurrentDomain.BaseDirectory;
            coreExe = Path.Combine(root, "twitchpc-agent.exe");
            envPath = Path.Combine(root, ".env");

            if (!File.Exists(coreExe))
            {
                MessageBox.Show("Cannot find " + coreExe, "TwitchPC Agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            controlPort = ReadControlPort();
            BuildTray();

            timer = new Timer();
            timer.Interval = 2000;
            timer.Tick += OnTick;
            timer.Start();

            StartAgent(false);
            Application.Run();

            timer.Stop();
            tray.Visible = false;
            tray.Dispose();
            menu.Dispose();
        }

        private static void BuildTray()
        {
            tray = new NotifyIcon();
            tray.Icon = SystemIcons.Application;
            tray.Text = "TwitchPC Agent - starting...";
            tray.Visible = true;

            menu = new ContextMenuStrip();
            ToolStripMenuItem openItem = new ToolStripMenuItem("Open settings");
            ToolStripMenuItem pairItem = new ToolStripMenuItem("Enter pairing code...");
            pauseItem = new ToolStripMenuItem("Pause commands");
            ToolStripMenuItem restartItem = new ToolStripMenuItem("Restart agent");
            ToolStripMenuItem exitItem = new ToolStripMenuItem("Exit");

            openItem.Click += delegate { ShowSettings(); };
            pairItem.Click += delegate { ShowPairingPrompt(false); };
            pauseItem.Click += delegate { TogglePause(); };
            restartItem.Click += delegate { RestartAgent(); };
            exitItem.Click += delegate { ExitApp(); };
            tray.DoubleClick += delegate { ShowSettings(); };

            menu.Items.Add(openItem);
            menu.Items.Add(pairItem);
            menu.Items.Add(pauseItem);
            menu.Items.Add(restartItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(exitItem);
            tray.ContextMenuStrip = menu;
        }

        private static Dictionary<string, string> ReadEnv()
        {
            Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (!File.Exists(envPath)) return values;

            foreach (string raw in File.ReadAllLines(envPath))
            {
                string line = raw.TrimStart();
                if (line.Length == 0 || line.StartsWith("#")) continue;

                Match match = Regex.Match(line, @"^(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$");
                if (!match.Success) continue;

                string value = match.Groups[2].Value.Trim();
                if (value.Length >= 2 &&
                    ((value[0] == '"' && value[value.Length - 1] == '"') ||
                     (value[0] == '\'' && value[value.Length - 1] == '\'')))
                {
                    value = value.Substring(1, value.Length - 2);
                }
                values[match.Groups[1].Value] = value;
            }
            return values;
        }

        private static string FormatEnvValue(string value)
        {
            if (value == null) return string.Empty;
            if (value.IndexOf('#') >= 0)
                return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
            return value;
        }

        private static void WriteEnv(Dictionary<string, string> values)
        {
            List<string> lines = File.Exists(envPath)
                ? new List<string>(File.ReadAllLines(envPath))
                : new List<string>();
            HashSet<string> written = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            for (int i = 0; i < lines.Count; i++)
            {
                Match match = Regex.Match(lines[i], @"^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=");
                if (!match.Success) continue;

                string key = match.Groups[1].Value;
                if (!values.ContainsKey(key)) continue;
                lines[i] = key + "=" + FormatEnvValue(values[key]);
                written.Add(key);
            }

            foreach (KeyValuePair<string, string> pair in values)
            {
                if (!written.Contains(pair.Key))
                    lines.Add(pair.Key + "=" + FormatEnvValue(pair.Value));
            }

            File.WriteAllLines(envPath, lines, new UTF8Encoding(false));
        }

        private static int ReadControlPort()
        {
            Dictionary<string, string> env = ReadEnv();
            string raw;
            int port;
            if (env.TryGetValue("AGENT_CONTROL_PORT", out raw) && int.TryParse(raw, out port) && port > 0)
                return port;
            return 4310;
        }

        private static string Control(string path, string method, string body = null)
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(
                    "http://127.0.0.1:" + controlPort + path);
                request.Method = method;
                request.Timeout = 1500;
                request.ReadWriteTimeout = 1500;
                if (body != null)
                {
                    byte[] bytes = Encoding.UTF8.GetBytes(body);
                    request.ContentType = "application/json";
                    request.ContentLength = bytes.Length;
                    using (Stream stream = request.GetRequestStream())
                    {
                        stream.Write(bytes, 0, bytes.Length);
                    }
                }
                else if (method == "POST")
                {
                    request.ContentLength = 0;
                }

                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    return reader.ReadToEnd();
                }
            }
            catch
            {
                return null;
            }
        }

        private static string JsonString(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return string.Empty;
            Match match = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"([^\"]*)\"");
            return match.Success ? match.Groups[1].Value : string.Empty;
        }

        private static bool JsonBool(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return false;
            Match match = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(true|false)");
            return match.Success && match.Groups[1].Value == "true";
        }

        private static string JsonEscape(string value)
        {
            if (value == null) return string.Empty;
            return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        private static void StartAgent(bool force)
        {
            if (stopping) return;
            if (agentProcess != null && !agentProcess.HasExited) return;
            if (!force && DateTime.Now < suppressUntil) return;

            controlPort = ReadControlPort();
            ProcessStartInfo startInfo = new ProcessStartInfo(coreExe);
            startInfo.WorkingDirectory = root;
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.WindowStyle = ProcessWindowStyle.Hidden;
            startInfo.EnvironmentVariables["AGENT_SUPERVISED"] = "1";

            try
            {
                agentProcess = Process.Start(startInfo);
            }
            catch (Exception error)
            {
                tray.ShowBalloonTip(4000, "TwitchPC Agent", "Could not start agent: " + error.Message, ToolTipIcon.Error);
            }
        }

        private static void StopAgent()
        {
            if (agentProcess != null)
            {
                Control("/shutdown", "POST");
                try
                {
                    if (!agentProcess.WaitForExit(800)) agentProcess.Kill();
                }
                catch
                {
                    try { agentProcess.Kill(); } catch { }
                }
            }
            agentProcess = null;
            suppressUntil = DateTime.Now.AddSeconds(1);
        }

        private static void RestartAgent()
        {
            StopAgent();
            StartAgent(true);
        }

        private static void TogglePause()
        {
            string state = Control("/status", "GET");
            if (state != null && JsonBool(state, "paused"))
                Control("/resume", "POST");
            else
                Control("/pause", "POST");
        }

        private static void ExitApp()
        {
            stopping = true;
            StopAgent();
            tray.Visible = false;
            timer.Stop();
            Application.ExitThread();
        }

        private static void OnTick(object sender, EventArgs e)
        {
            if (stopping) return;

            if (agentProcess == null || agentProcess.HasExited) StartAgent(false);

            string state = Control("/status", "GET");
            string label;
            if (state == null)
            {
                label = "starting...";
                pauseItem.Text = "Pause commands";
            }
            else if (JsonBool(state, "needsPairing"))
            {
                label = "pairing needed";
                pauseItem.Text = "Pause commands";
                if (!pairPromptOpen && DateTime.Now >= pairingSuppressedUntil)
                    ShowPairingPrompt(true);
            }
            else if (JsonBool(state, "paused"))
            {
                label = "paused";
                pauseItem.Text = "Resume commands";
            }
            else if (JsonBool(state, "connected"))
            {
                label = "connected";
                pauseItem.Text = "Pause commands";
            }
            else
            {
                label = "connecting...";
                pauseItem.Text = "Pause commands";
            }

            tray.Text = "TwitchPC Agent - " + label;
        }

        private static void ShowPairingPrompt(bool automatic)
        {
            if (pairPromptOpen) return;
            pairPromptOpen = true;
            Dictionary<string, string> env = ReadEnv();

            Form form = new Form();
            form.Text = "Pair TwitchPC Agent";
            form.StartPosition = FormStartPosition.CenterScreen;
            form.Size = new Size(480, 340);
            form.MinimumSize = form.Size;
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.MaximizeBox = false;
            form.MinimizeBox = false;

            TableLayoutPanel layout = new TableLayoutPanel();
            layout.Dock = DockStyle.Fill;
            layout.RowCount = 6;
            layout.ColumnCount = 1;
            layout.Padding = new Padding(16);
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 52F));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 18F));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 30F));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 18F));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 30F));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 44F));

            Label instruction = new Label();
            instruction.Dock = DockStyle.Fill;
            instruction.Text = automatic
                ? "This agent needs a pairing code. Generate one in the TwitchPC dashboard (Pair agent → Generate code), then paste it here. Enter the cloud URL if this is a new install."
                : "Generate a code in the TwitchPC dashboard (Pair agent → Generate code), then paste it here.";

            Label cloudLabel = new Label();
            cloudLabel.Text = "Cloud URL (wss://.../agent)";
            cloudLabel.Dock = DockStyle.Fill;

            TextBox cloudBox = new TextBox();
            cloudBox.Dock = DockStyle.Fill;
            string configuredCloudUrl;
            if (!env.TryGetValue("CLOUD_URL", out configuredCloudUrl) || string.IsNullOrWhiteSpace(configuredCloudUrl))
                configuredCloudUrl = "wss://my-machine.my-tailnet.ts.net/agent";
            cloudBox.Text = configuredCloudUrl;

            Label codeLabel = new Label();
            codeLabel.Text = "One-time pairing code";
            codeLabel.Dock = DockStyle.Fill;

            TextBox codeBox = new TextBox();
            codeBox.Dock = DockStyle.Fill;
            codeBox.CharacterCasing = CharacterCasing.Upper;
            codeBox.Font = new Font("Consolas", 12F);

            Panel buttons = new Panel();
            buttons.Dock = DockStyle.Fill;

            Button cancel = new Button();
            cancel.Text = "Later";
            cancel.Size = new Size(90, 32);
            cancel.Location = new Point(326, 4);
            cancel.DialogResult = DialogResult.Cancel;
            buttons.Controls.Add(cancel);

            Button pair = new Button();
            pair.Text = "Pair";
            pair.Size = new Size(110, 32);
            pair.Location = new Point(206, 4);
            pair.Click += delegate
            {
                string code = codeBox.Text.Trim().ToUpperInvariant();
                if (code.Length == 0)
                {
                    MessageBox.Show("Enter the code from the dashboard.", "TwitchPC Agent");
                    return;
                }

                pair.Enabled = false;
                string response = Control(
                    "/pair",
                    "POST",
                    "{\"code\":\"" + JsonEscape(code) + "\",\"cloudUrl\":\"" +
                    JsonEscape(cloudBox.Text.Trim()) + "\"}");
                string agentId = JsonString(response, "agentId");
                if (!string.IsNullOrEmpty(agentId))
                {
                    form.DialogResult = DialogResult.OK;
                    form.Close();
                    pairingSuppressedUntil = DateTime.MinValue;
                    tray.ShowBalloonTip(4000, "TwitchPC Agent", "Paired as " + agentId, ToolTipIcon.Info);
                }
                else
                {
                    string error = JsonString(response, "error");
                    if (string.IsNullOrEmpty(error)) error = "Could not reach the agent. Try again in a moment.";
                    MessageBox.Show(error, "Pairing failed", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    pairingSuppressedUntil = DateTime.Now.AddSeconds(5);
                    pair.Enabled = true;
                }
            };
            buttons.Controls.Add(pair);

            layout.Controls.Add(instruction, 0, 0);
            layout.Controls.Add(cloudLabel, 0, 1);
            layout.Controls.Add(cloudBox, 0, 2);
            layout.Controls.Add(codeLabel, 0, 3);
            layout.Controls.Add(codeBox, 0, 4);
            layout.Controls.Add(buttons, 0, 5);
            form.Controls.Add(layout);
            form.ActiveControl = codeBox;

            try
            {
                form.ShowDialog();
                if (form.DialogResult != DialogResult.OK)
                    pairingSuppressedUntil = DateTime.Now.AddSeconds(30);
            }
            finally
            {
                form.Dispose();
                pairPromptOpen = false;
            }
        }

        private static void ShowSettings()
        {
            Dictionary<string, string> env = ReadEnv();
            string state = Control("/status", "GET");

            Form form = new Form();
            form.Text = "TwitchPC Agent settings";
            form.StartPosition = FormStartPosition.CenterScreen;
            form.Size = new Size(560, 650);
            form.MinimumSize = form.Size;
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.MaximizeBox = false;
            form.MinimizeBox = false;

            TableLayoutPanel layout = new TableLayoutPanel();
            layout.Dock = DockStyle.Fill;
            layout.RowCount = 3;
            layout.ColumnCount = 1;
            layout.Padding = new Padding(12);
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 32F));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 52F));

            Label statusLabel = new Label();
            statusLabel.Dock = DockStyle.Fill;
            statusLabel.TextAlign = ContentAlignment.MiddleLeft;
            if (state == null)
            {
                statusLabel.Text = "Status: unavailable (agent is starting)";
            }
            else
            {
                string text;
                if (JsonBool(state, "needsPairing")) text = "Pairing needed";
                else if (JsonBool(state, "paused")) text = "Paused";
                else if (JsonBool(state, "connected")) text = "Connected";
                else text = "Connecting...";

                statusLabel.Text = "Status: " + text +
                    "  |  Agent: " + JsonString(state, "agentId") +
                    "  |  v" + JsonString(state, "version");
            }

            Panel fieldsPanel = new Panel();
            fieldsPanel.Dock = DockStyle.Fill;
            fieldsPanel.AutoScroll = true;

            Dictionary<string, TextBox> boxes = new Dictionary<string, TextBox>(StringComparer.OrdinalIgnoreCase);
            int y = 8;
            foreach (Field field in Fields)
            {
                Label label = new Label();
                label.Text = field.Label;
                label.Location = new Point(6, y);
                label.Size = new Size(500, 18);
                fieldsPanel.Controls.Add(label);
                y += 20;

                TextBox box = new TextBox();
                box.Location = new Point(6, y);
                box.Size = new Size(500, 26);
                string existing;
                if (env.TryGetValue(field.Key, out existing)) box.Text = existing;
                if (field.Secret) box.PasswordChar = '*';
                fieldsPanel.Controls.Add(box);
                boxes[field.Key] = box;
                y += 38;
            }

            Panel buttonPanel = new Panel();
            buttonPanel.Dock = DockStyle.Fill;

            Button cancel = new Button();
            cancel.Text = "Cancel";
            cancel.Size = new Size(100, 32);
            cancel.Location = new Point(424, 8);
            cancel.DialogResult = DialogResult.Cancel;
            buttonPanel.Controls.Add(cancel);

            Button save = new Button();
            save.Text = "Save and restart";
            save.Size = new Size(160, 32);
            save.Location = new Point(252, 8);
            save.Click += delegate
            {
                Dictionary<string, string> updated = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (Field field in Fields)
                    updated[field.Key] = boxes[field.Key].Text.Trim();
                WriteEnv(updated);
                form.DialogResult = DialogResult.OK;
                form.Close();
                RestartAgent();
            };
            buttonPanel.Controls.Add(save);

            layout.Controls.Add(statusLabel, 0, 0);
            layout.Controls.Add(fieldsPanel, 0, 1);
            layout.Controls.Add(buttonPanel, 0, 2);
            form.Controls.Add(layout);

            form.ShowDialog();
            form.Dispose();
        }
    }
}

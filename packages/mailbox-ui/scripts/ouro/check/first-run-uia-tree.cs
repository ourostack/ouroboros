// Ouro's first-run harness on Windows: the eyes and hands, through UI Automation and the system's own input, with the line
// protocol of first-run-ax-tree.swift, so first-run-eyes.ts's Eyes, the judges and the session run unchanged. Generic: no
// app names. Built with the .NET Framework's csc (first-run-windows.ts buildWindowsEyes); each answer is one JSON line. Roles are
// given in the accessibility names the judges read (AXButton, AXHeading, AXWebArea; a WebView2 page's landmarks and dialogs
// from its localized control types), and a web element's DOM id and classes from its AutomationId and ClassName, as
// Chromium sets them. Coordinates are pixels. A window parked off the screen (a hidden helper) is nothing a person sees.
//   trust | tree <pid> | shown <pid> | close-window <pid> | activate <pid> | windows
//   extras <pid> | extra-menu <pid> <n> [name] | extra-press <title>   the notification-area icon (by its name: [name],
//     else OURO_TRAY_NAME, else the process's window title, given 10 s to appear) and its menu
//   press <pid> <label> | focus <pid> | type <text> | key <name> | click <x> <y>
//   shot <file> [x y w h] | pixels <png> <x> <y> <w> <h>
// Run as `<built eyes>.exe --shot <file> [x y w h]`, it takes one picture and ends: the harness's screencapture on Windows.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

static class Eyes
{
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit, Size = 40)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }

  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 400 };
  static void Say(object o) { Console.WriteLine(Json.Serialize(o)); Console.Out.Flush(); }

  static readonly HashSet<string> Pressable = new HashSet<string> { "AXButton", "AXLink", "AXMenuItem", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXTab" };
  static AutomationElement openMenu;

  static string Role(AutomationElement e)
  {
    var ct = e.Cached.ControlType;
    var loc = (e.Cached.LocalizedControlType ?? "").ToLowerInvariant();
    if (loc == "heading") return "AXHeading";
    if (ct == ControlType.Window) return "AXWindow";
    if (ct == ControlType.Button) return "AXButton";
    if (ct == ControlType.Hyperlink) return "AXLink";
    if (ct == ControlType.Text) return "AXStaticText";
    if (ct == ControlType.Edit) return "AXTextField";
    if (ct == ControlType.Document) return "AXWebArea";
    if (ct == ControlType.CheckBox) return "AXCheckBox";
    if (ct == ControlType.RadioButton) return "AXRadioButton";
    if (ct == ControlType.MenuItem) return "AXMenuItem";
    if (ct == ControlType.Menu) return "AXMenu";
    if (ct == ControlType.TabItem) return "AXTab";
    if (ct == ControlType.Image) return "AXImage";
    if (ct == ControlType.ProgressBar) return "AXProgressIndicator";
    if (ct == ControlType.ComboBox) return "AXPopUpButton";
    if (ct == ControlType.SplitButton) return "AXMenuButton";
    if (ct == ControlType.ListItem) return "AXListItem";
    if (ct == ControlType.DataItem) return "AXRow";
    if (ct == ControlType.ToolBar) return "AXToolbar";
    return "AXGroup";
  }

  static string Subrole(AutomationElement e, string role)
  {
    var loc = (e.Cached.LocalizedControlType ?? "").ToLowerInvariant();
    if (loc == "main") return "AXLandmarkMain";
    if (loc == "navigation") return "AXLandmarkNavigation";
    if (loc == "alert dialog") return "AXApplicationAlertDialog";
    if (loc == "dialog") return role == "AXWindow" ? "AXDialog" : "AXApplicationDialog";
    return null;
  }

  static CacheRequest Request(TreeScope scope)
  {
    var r = new CacheRequest { TreeScope = scope, AutomationElementMode = AutomationElementMode.Full };
    foreach (var p in new[] { AutomationElement.ControlTypeProperty, AutomationElement.LocalizedControlTypeProperty, AutomationElement.NameProperty, AutomationElement.IsEnabledProperty,
      AutomationElement.HasKeyboardFocusProperty, AutomationElement.BoundingRectangleProperty, AutomationElement.AutomationIdProperty, AutomationElement.ClassNameProperty,
      AutomationElement.IsOffscreenProperty, ValuePattern.ValueProperty, AutomationElement.ProcessIdProperty })
      r.Add(p);
    r.TreeFilter = Automation.ControlViewCondition;
    return r;
  }

  static string Words(AutomationElement e)
  {
    var parts = new List<string>();
    var name = e.Cached.Name;
    if (!string.IsNullOrEmpty(name)) parts.Add(name.Length > 160 ? name.Substring(0, 160) : name);
    var v = e.GetCachedPropertyValue(ValuePattern.ValueProperty, true) as string;
    if (!string.IsNullOrEmpty(v) && v != name) parts.Add(v.Length > 160 ? v.Substring(0, 160) : v);
    return string.Join(" | ", parts);
  }

  /// Depth-first and bounded: each element once, with its parent's index, from the cached subtree.
  static List<Dictionary<string, object>> Flatten(AutomationElement root, ref int budget)
  {
    var nodes = new List<Dictionary<string, object>>();
    int left = budget;
    Action<AutomationElement, int, int> visit = null;
    visit = (e, parent, depth) =>
    {
      if (depth >= 48 || left <= 0) return;
      left--;
      var role = Role(e);
      var n = new Dictionary<string, object> { { "i", nodes.Count }, { "p", parent }, { "d", depth }, { "role", role } };
      var sub = Subrole(e, role);
      if (sub != null) n["subrole"] = sub;
      var words = Words(e);
      if (words.Length > 0) n["words"] = words;
      n["enabled"] = e.Cached.IsEnabled;
      if (e.Cached.HasKeyboardFocus) n["focused"] = true;
      var r = e.Cached.BoundingRectangle;
      if (!e.Cached.IsOffscreen && !r.IsEmpty && !double.IsInfinity(r.Width)) { n["x"] = (int)r.X; n["y"] = (int)r.Y; n["w"] = (int)r.Width; n["h"] = (int)r.Height; }
      if (!string.IsNullOrEmpty(e.Cached.AutomationId)) n["domId"] = e.Cached.AutomationId;
      var cls = (e.Cached.ClassName ?? "").Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
      if (cls.Length > 0) n["domClass"] = cls;
      var me = nodes.Count;
      nodes.Add(n);
      foreach (AutomationElement c in e.CachedChildren) visit(c, me, depth + 1);
    };
    visit(root, -1, 0);
    budget = left;
    return nodes;
  }

  /// The process's top-level windows a person can see.
  static List<IntPtr> Shown(uint pid)
  {
    var list = new List<IntPtr>();
    EnumWindows((h, p) =>
    {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      RECT r;
      if (owner == pid && IsWindowVisible(h) && !IsIconic(h) && GetWindowRect(h, out r) && r.Right - r.Left > 200 && r.Bottom - r.Top > 150 && r.Right > 0 && r.Bottom > 0) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  /// The process's top-level windows on the screen: one parked off it (at -32000, as a hidden helper window is) is not
  /// one a person can see or use, so it is never read or pressed.
  static IEnumerable<AutomationElement> WindowsOf(int pid)
  {
    var cond = new PropertyCondition(AutomationElement.ProcessIdProperty, pid);
    var screen = new System.Windows.Rect(GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79));
    return AutomationElement.RootElement.FindAll(TreeScope.Children, cond).Cast<AutomationElement>().Where(w =>
    {
      var r = w.Current.BoundingRectangle;
      return !r.IsEmpty && r.IntersectsWith(screen);
    });
  }

  static void Click(int x, int y, bool right = false)
  {
    SetCursorPos(x, y);
    Thread.Sleep(40);
    mouse_event(right ? 0x0008u : 0x0002u, 0, 0, 0, UIntPtr.Zero);
    Thread.Sleep(30);
    mouse_event(right ? 0x0010u : 0x0004u, 0, 0, 0, UIntPtr.Zero);
  }

  static void Key(ushort vk, bool up) { Send(new INPUT { type = 1, ki = new KEYBDINPUT { wVk = vk, dwFlags = up ? 2u : 0u } }); }
  static void Send(INPUT i) { SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT))); Thread.Sleep(8); }
  static void Unicode(char c)
  {
    Send(new INPUT { type = 1, ki = new KEYBDINPUT { wScan = c, dwFlags = 0x0004 } });
    Send(new INPUT { type = 1, ki = new KEYBDINPUT { wScan = c, dwFlags = 0x0004 | 0x0002 } });
  }

  static bool Press(AutomationElement e)
  {
    object p;
    if (e.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { ((InvokePattern)p).Invoke(); return true; }
    if (e.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); return true; }
    if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); return true; }
    if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) { ((ExpandCollapsePattern)p).Expand(); return true; }
    var r = e.Current.BoundingRectangle;
    if (r.IsEmpty) return false;
    Click((int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2));
    return true;
  }

  /// The notification-area buttons whose names start with `title`, in the taskbar or its overflow.
  static List<AutomationElement> TrayButtons(string title)
  {
    var found = new List<AutomationElement>();
    var buttons = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button);
    foreach (var cls in new[] { "Shell_TrayWnd", "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland" })
    {
      var bar = AutomationElement.RootElement.FindFirst(TreeScope.Children, new PropertyCondition(AutomationElement.ClassNameProperty, cls));
      if (bar == null) continue;
      foreach (AutomationElement b in bar.FindAll(TreeScope.Descendants, buttons))
      {
        // The taskbar's own button for the app's window ("App - 1 running window") lives here too: not the icon.
        var name = b.Current.Name ?? "";
        if (name.StartsWith(title, StringComparison.OrdinalIgnoreCase) && name.IndexOf("running window", StringComparison.OrdinalIgnoreCase) < 0 && name.IndexOf("pinned", StringComparison.OrdinalIgnoreCase) < 0) found.Add(b);
      }
    }
    return found;
  }

  static string TitleOf(uint pid)
  {
    string title = "";
    EnumWindows((h, p) =>
    {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner != pid) return true;
      var t = new StringBuilder(128);
      GetWindowText(h, t, 128);
      if (t.Length > 0 && title.Length == 0) title = t.ToString();
      return true;
    }, IntPtr.Zero);
    return title;
  }

  static Dictionary<string, object> Pixels(string file, double x, double y, double w, double h)
  {
    using (var img = new Bitmap(file))
    {
      var whole = w <= 0 || h <= 0;
      int inset = 24;
      var rect = whole ? new Rectangle(inset, inset, img.Width - 2 * inset, img.Height - 2 * inset) : new Rectangle((int)x + inset, (int)y + inset, (int)w - 2 * inset, (int)h - 2 * inset);
      rect.Intersect(new Rectangle(0, 0, img.Width, img.Height));
      if (rect.Width < 4 || rect.Height < 4) return new Dictionary<string, object> { { "ok", false }, { "why", "nothing to read in that rectangle" } };
      var data = img.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      var hist = new long[256];
      long sum = 0, total = 0;
      var row = new byte[data.Stride];
      for (int j = 0; j < rect.Height; j++)
      {
        Marshal.Copy(data.Scan0 + j * data.Stride, row, 0, data.Stride);
        for (int i = 0; i < rect.Width; i++)
        {
          int g = (row[i * 4 + 2] * 299 + row[i * 4 + 1] * 587 + row[i * 4] * 114) / 1000;
          hist[g]++;
          sum += g;
          total++;
        }
      }
      img.UnlockBits(data);
      int top = Array.IndexOf(hist, hist.Max());
      long near = 0;
      for (int k = Math.Max(0, top - 2); k <= Math.Min(255, top + 2); k++) near += hist[k];
      return new Dictionary<string, object> { { "ok", true }, { "uniform", (double)near / total }, { "mean", (double)sum / total } };
    }
  }

  static readonly Dictionary<string, ushort> Keys = new Dictionary<string, ushort> { { "escape", 0x1B }, { "return", 0x0D }, { "tab", 0x09 }, { "space", 0x20 }, { "comma", 0xBC } };

  static void Shot(string file, string[] rect)
  {
    int sx = 0, sy = 0, sw = GetSystemMetrics(0), sh = GetSystemMetrics(1);
    if (rect.Length == 4) { sx = int.Parse(rect[0]); sy = int.Parse(rect[1]); sw = int.Parse(rect[2]); sh = int.Parse(rect[3]); }
    using (var bmp = new Bitmap(Math.Max(1, sw), Math.Max(1, sh)))
    {
      using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(sx, sy, 0, 0, bmp.Size);
      bmp.Save(file, ImageFormat.Png);
    }
  }

  static int Main(string[] args)
  {
    SetProcessDPIAware();
    if (args.Length >= 2 && args[0] == "--shot")
    {
      try { Shot(args[1], args.Skip(2).ToArray()); return 0; }
      catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }
    Console.OutputEncoding = Encoding.UTF8;
    string line;
    while ((line = Console.ReadLine()) != null)
    {
      var parts = line.Split(new[] { ' ' }, 3);
      var cmd = parts[0];
      try
      {
        switch (cmd)
        {
          case "trust":
            Say(new Dictionary<string, object> { { "ok", true }, { "accessibility", true }, { "postEvent", true }, { "screen", true } });
            break;
          case "windows":
          {
            var rows = new List<object>();
            EnumWindows((h, p) =>
            {
              RECT r;
              if (!IsWindowVisible(h) || !GetWindowRect(h, out r) || r.Right - r.Left < 50) return true;
              uint pid;
              GetWindowThreadProcessId(h, out pid);
              var t = new StringBuilder(256);
              GetWindowText(h, t, 256);
              string owner = "";
              try { owner = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
              rows.Add(new Dictionary<string, object> { { "owner", owner }, { "pid", (int)pid }, { "name", t.ToString() }, { "layer", 0 }, { "x", r.Left }, { "y", r.Top }, { "w", r.Right - r.Left }, { "h", r.Bottom - r.Top } });
              return true;
            }, IntPtr.Zero);
            Say(new Dictionary<string, object> { { "ok", true }, { "windows", rows } });
            break;
          }
          case "tree":
          {
            int pid = int.Parse(parts[1]), budget = 9000;
            var windows = new List<object>();
            var req = Request(TreeScope.Element | TreeScope.Descendants);
            foreach (var w in WindowsOf(pid))
            {
              var r = w.Current.BoundingRectangle;
              if (w.Current.IsOffscreen || r.X + r.Width <= 0 || r.Y + r.Height <= 0) continue;
              AutomationElement cached;
              using (req.Activate()) cached = w.GetUpdatedCache(req);
              windows.Add(new Dictionary<string, object> { { "title", w.Current.Name ?? "" }, { "x", (int)r.X }, { "y", (int)r.Y }, { "w", (int)r.Width }, { "h", (int)r.Height }, { "nodes", Flatten(cached, ref budget) } });
            }
            Say(new Dictionary<string, object> { { "ok", true }, { "windows", windows }, { "budgetLeft", budget } });
            break;
          }
          case "shown":
          {
            var rows = Shown(uint.Parse(parts[1])).Select(h => { RECT r; GetWindowRect(h, out r); return (object)new Dictionary<string, object> { { "w", r.Right - r.Left }, { "h", r.Bottom - r.Top } }; }).ToList();
            Say(new Dictionary<string, object> { { "ok", true }, { "windows", rows } });
            break;
          }
          case "close-window":
          {
            var w = WindowsOf(int.Parse(parts[1])).FirstOrDefault(x => !x.Current.IsOffscreen);
            object p;
            var ok = w != null && w.TryGetCurrentPattern(WindowPattern.Pattern, out p);
            if (ok) ((WindowPattern)w.GetCurrentPattern(WindowPattern.Pattern)).Close();
            Say(new Dictionary<string, object> { { "ok", ok } });
            break;
          }
          case "activate":
          {
            var h = Shown(uint.Parse(parts[1])).FirstOrDefault();
            var ok = h != IntPtr.Zero && SetForegroundWindow(h);
            Say(new Dictionary<string, object> { { "ok", ok } });
            break;
          }
          case "extras":
          {
            var names = TrayButtons(TitleOf(uint.Parse(parts[1]))).Select(b => (object)b.Current.Name).ToList();
            Say(new Dictionary<string, object> { { "ok", names.Count > 0 }, { "items", names } });
            break;
          }
          case "extra-menu":
          {
            // extra-menu <pid> <n> [name]: the icon's name (its tooltip) when the app gives one, else its windows' title.
            var rest = parts.Length > 2 ? parts[2].Split(new[] { ' ' }, 2) : new string[0];
            int pid = int.Parse(parts[1]), n = rest.Length > 0 ? int.Parse(rest[0]) : 0;
            var named = Environment.GetEnvironmentVariable("OURO_TRAY_NAME");
            var title = rest.Length > 1 ? rest[1] : !string.IsNullOrEmpty(named) ? named : TitleOf((uint)pid);
            // An app puts its icon up a moment after its window: 10 s for it to appear, so an early look isn't a flake.
            var buttons = TrayButtons(title);
            for (var until = DateTime.UtcNow.AddSeconds(10); buttons.Count <= n && DateTime.UtcNow < until; buttons = TrayButtons(title)) Thread.Sleep(1000);
            if (buttons.Count <= n)
            {
              // Windows tucks icons into the overflow: open it, then look again.
              var chevron = AutomationElement.RootElement.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, "Show Hidden Icons", PropertyConditionFlags.IgnoreCase));
              if (chevron != null) { Press(chevron); Thread.Sleep(700); buttons = TrayButtons(title); }
            }
            if (buttons.Count <= n)
            {
              var all = TrayButtons("").Select(b => b.Current.Name).Where(x => !string.IsNullOrEmpty(x)).Take(20);
              Say(new Dictionary<string, object> { { "ok", false }, { "why", "no notification-area icon named \"" + title + "\" (the icons there: " + string.Join(", ", all) + ")" }, { "items", new object[0] } });
              break;
            }
            var r = buttons[n].Current.BoundingRectangle;
            Click((int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2), true);
            AutomationElement menu = null;
            for (int i = 0; i < 20 && menu == null; i++)
            {
              Thread.Sleep(100);
              menu = AutomationElement.RootElement.FindFirst(TreeScope.Descendants, new AndCondition(new PropertyCondition(AutomationElement.ProcessIdProperty, pid), new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Menu)));
            }
            openMenu = menu;
            if (menu == null) { Say(new Dictionary<string, object> { { "ok", false }, { "why", "right-clicked \"" + buttons[n].Current.Name + "\" at " + (int)(r.X + r.Width / 2) + "," + (int)(r.Y + r.Height / 2) + ", and no menu of process " + pid + " appeared within 2 s" }, { "items", new object[0] } }); break; }
            var items = menu == null ? new List<object>() : menu.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem)).Cast<AutomationElement>()
              .Select(m => (object)new Dictionary<string, object> { { "title", m.Current.Name ?? "" }, { "enabled", m.Current.IsEnabled } }).ToList();
            Say(new Dictionary<string, object> { { "ok", menu != null }, { "items", items } });
            break;
          }
          case "extra-press":
          {
            var title = line.Substring("extra-press ".Length);
            var hit = openMenu == null ? null : openMenu.FindFirst(TreeScope.Descendants, new AndCondition(new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem), new PropertyCondition(AutomationElement.NameProperty, title)));
            var ok = hit != null && Press(hit);
            openMenu = null;
            Say(new Dictionary<string, object> { { "ok", ok } });
            break;
          }
          case "press":
          {
            int pid = int.Parse(parts[1]);
            var want = parts[2];
            var prefix = want.EndsWith("*");
            if (prefix) want = want.Substring(0, want.Length - 1);
            var req = Request(TreeScope.Element | TreeScope.Descendants);
            AutomationElement hit = null, dialog = null;
            foreach (var w in WindowsOf(pid))
            {
              if (w.Current.IsOffscreen) continue;
              AutomationElement cached;
              using (req.Activate()) cached = w.GetUpdatedCache(req);
              Action<AutomationElement> findDialog = null;
              findDialog = e => { var s = Subrole(e, Role(e)); if (s == "AXApplicationDialog" || s == "AXApplicationAlertDialog") dialog = e; foreach (AutomationElement c in e.CachedChildren) findDialog(c); };
              findDialog(cached);
              Func<AutomationElement, AutomationElement> find = null;
              find = e =>
              {
                var names = Words(e).Split(new[] { " | " }, StringSplitOptions.None);
                if (Pressable.Contains(Role(e)) && e.Cached.IsEnabled && names.Any(x => prefix ? x.StartsWith(want) : x == want)) return e;
                foreach (AutomationElement c in e.CachedChildren) { var f = find(c); if (f != null) return f; }
                return null;
              };
              hit = find(dialog ?? cached);
              if (hit != null) break;
            }
            Say(new Dictionary<string, object> { { "ok", hit != null && Press(hit) } });
            break;
          }
          case "focus":
          {
            var edit = WindowsOf(int.Parse(parts[1])).Select(w => w.FindFirst(TreeScope.Descendants, new AndCondition(new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit), new PropertyCondition(AutomationElement.IsOffscreenProperty, false)))).FirstOrDefault(x => x != null);
            if (edit != null) edit.SetFocus();
            Say(new Dictionary<string, object> { { "ok", edit != null } });
            break;
          }
          case "type":
            foreach (var c in line.Substring(5)) Unicode(c);
            Say(new Dictionary<string, object> { { "ok", true } });
            break;
          case "key":
          {
            var pieces = parts[1].Split('-');
            var mods = new List<ushort>();
            // A Mac's ⌘ is Windows' Ctrl, so an app's shortcuts read the same on both.
            if (pieces.Contains("cmd") || pieces.Contains("ctrl")) mods.Add(0x11);
            if (pieces.Contains("shift")) mods.Add(0x10);
            if (pieces.Contains("alt")) mods.Add(0x12);
            var b = pieces.Last();
            ushort vk = Keys.ContainsKey(b) ? Keys[b] : (b.Length == 1 ? (ushort)char.ToUpperInvariant(b[0]) : (ushort)0);
            if (vk == 0) { Say(new Dictionary<string, object> { { "ok", false }, { "why", "unknown key " + parts[1] } }); break; }
            foreach (var m in mods) Key(m, false);
            Key(vk, false);
            Key(vk, true);
            foreach (var m in Enumerable.Reverse(mods)) Key(m, true);
            Say(new Dictionary<string, object> { { "ok", true } });
            break;
          }
          case "click":
            Click(int.Parse(parts[1]), int.Parse(parts[2]));
            Say(new Dictionary<string, object> { { "ok", true } });
            break;
          case "shot":
          {
            var a = line.Split(' ');
            Shot(a[1], a.Skip(2).ToArray());
            Say(new Dictionary<string, object> { { "ok", true } });
            break;
          }
          case "pixels":
          {
            var a = line.Split(' ');
            Say(Pixels(a[1], double.Parse(a[2]), double.Parse(a[3]), double.Parse(a[4]), double.Parse(a[5])));
            break;
          }
          default:
            Say(new Dictionary<string, object> { { "ok", false }, { "why", "unknown command" } });
            break;
        }
      }
      catch (Exception e)
      {
        Say(new Dictionary<string, object> { { "ok", false }, { "why", e.GetType().Name + ": " + e.Message } });
      }
    }
    return 0;
  }
}

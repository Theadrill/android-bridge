Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class WinAPI {
    public delegate bool EnumWindowsProc(IntPtr hWnd, int lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumFunc, int lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", ExactSpelling = true)]
    public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);

    [DllImport("user32.dll")]
    public static extern IntPtr GetLastActivePopup(IntPtr hWnd);

    public static List<string> GetWindows() {
        List<string> result = new List<string>();

        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;

            int cloakedVal = 0;
            DwmGetWindowAttribute(hWnd, 14, out cloakedVal, sizeof(int));
            if (cloakedVal != 0) return true;

            IntPtr root = GetAncestor(hWnd, 3);
            if (GetLastActivePopup(root) != hWnd) return true;

            StringBuilder title = new StringBuilder(256);
            GetWindowText(hWnd, title, 256);
            if (title.Length == 0 || title.ToString() == "Program Manager" || title.ToString() == "Settings") return true;

            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);

            result.Add(processId + "|||" + title.ToString().Replace("\r", "").Replace("\n", ""));
            return true;
        }, 0);

        return result;
    }
}
"@
$windows = [WinAPI]::GetWindows()
foreach ($w in $windows) { Write-Output $w }

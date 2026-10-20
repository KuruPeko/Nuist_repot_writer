using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("ReportWriter")]
[assembly: AssemblyProduct("ReportWriter")]
[assembly: AssemblyDescription("启动 ReportWriter")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

internal static class AppLauncher
{
    [STAThread]
    private static void Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
        string app = Path.Combine(dir, "app.py");
        if (!File.Exists(app))
        {
            MessageBox.Show(
                "找不到 app.py。\n\n请把本程序放在 ReportWriter 文件夹里，和 app.py 一起运行。",
                "ReportWriter", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        // 与旧的启动脚本保持一致：优先用 DSH 自带的 pythonw，避免弹出控制台窗口。
        string pyDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".dsh", "dsh-runtimes", "dsh-primary-runtime", "dependencies", "python");
        string pythonw = Path.Combine(pyDir, "pythonw.exe");
        if (!File.Exists(pythonw))
        {
            string python = Path.Combine(pyDir, "python.exe");
            pythonw = File.Exists(python) ? python : "pythonw.exe";
        }

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = pythonw,
                Arguments = "\"" + app + "\"",
                WorkingDirectory = dir,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "启动 ReportWriter 失败：\n" + ex.Message,
                "ReportWriter", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}

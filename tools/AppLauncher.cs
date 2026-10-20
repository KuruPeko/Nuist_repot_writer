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
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string bat = Path.Combine(dir, "启动ReportWriter.bat");
        if (!File.Exists(bat))
        {
            MessageBox.Show(
                "找不到 启动ReportWriter.bat。\n\n请把本程序放在 ReportWriter 文件夹里，和 app.py 一起运行。",
                "ReportWriter", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        try
        {
            // 隐藏 cmd 窗口；bat 内部会用 pythonw 启动服务并立即退出。
            var psi = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = "/c \"\"" + bat + "\"\"",
                WorkingDirectory = dir,
                UseShellExecute = true,
                WindowStyle = ProcessWindowStyle.Hidden
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

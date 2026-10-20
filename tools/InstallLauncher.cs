using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("ReportWriter 一键安装")]
[assembly: AssemblyProduct("ReportWriter")]
[assembly: AssemblyDescription("启动 ReportWriter 安装脚本")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

internal static class InstallLauncher
{
    [STAThread]
    private static void Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
        string script = Path.Combine(dir, "install.ps1");
        if (!File.Exists(script))
        {
            MessageBox.Show(
                "找不到 install.ps1。\n\n请把本程序放在 ReportWriter 文件夹里，和 install.ps1 一起运行。",
                "ReportWriter 安装", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"",
                WorkingDirectory = dir,
                UseShellExecute = true,
                WindowStyle = ProcessWindowStyle.Normal
            };
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "启动安装脚本失败：\n" + ex.Message,
                "ReportWriter 安装", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}

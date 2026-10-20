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
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string bat = Path.Combine(dir, "一键安装.bat");
        if (!File.Exists(bat))
        {
            MessageBox.Show(
                "找不到 一键安装.bat。\n\n请把本程序放在 ReportWriter 文件夹里，和 install.ps1 一起运行。",
                "ReportWriter 安装", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        try
        {
            // 走 cmd /c，让现有的 .bat 继续负责 chcp、pause 和错误码。
            var psi = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = "/c \"\"" + bat + "\"\"",
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

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("ReportWriter 一键卸载")]
[assembly: AssemblyProduct("ReportWriter")]
[assembly: AssemblyDescription("卸载 ReportWriter")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

internal static class UninstallLauncher
{
    [STAThread]
    private static void Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
        string script = Path.Combine(dir, "uninstall.ps1");
        if (!File.Exists(script))
        {
            MessageBox.Show(
                "找不到 uninstall.ps1。\n\n请把本程序放在 ReportWriter 文件夹里再运行。",
                "ReportWriter 卸载", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        string runScript = script;
        try
        {
            // 复制到临时目录再执行，这样卸载脚本可以安全地删掉程序目录里的自己。
            string tempDir = Path.Combine(Path.GetTempPath(),
                "ReportWriter-uninstall-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            string tempScript = Path.Combine(tempDir, "uninstall.ps1");
            File.Copy(script, tempScript, true);
            runScript = tempScript;
        }
        catch
        {
            // 临时目录不可用时，退回原地执行；脚本会跳过删除自身。
        }

        try
        {
            string args = "-NoProfile -ExecutionPolicy Bypass -File \"" + runScript +
                          "\" -Root \"" + dir + "\"";
            var psi = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = args,
                WorkingDirectory = dir,
                UseShellExecute = true,
                WindowStyle = ProcessWindowStyle.Normal
            };
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "启动卸载脚本失败：\n" + ex.Message,
                "ReportWriter 卸载", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}

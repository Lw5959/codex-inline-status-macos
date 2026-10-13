Option Explicit
Dim shell, files, root, launcher, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\CodexInlineStatus"
launcher = root & "\Launch-Codex.ps1"
If Not files.FileExists(launcher) Then
    MsgBox "Please run the installer in this source kit first.", 48, "Codex status"
    WScript.Quit 1
End If
result = shell.Run("powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & launcher & """", 0, True)
If result <> 0 Then
    MsgBox "Status attachment was not confirmed. If Codex is already open, close it yourself and use this launcher again. For details run Launch-Codex.ps1 in PowerShell, or inspect Documents\ChatGPT-Tools\inline-status-state.", 48, "Codex status"
End If
WScript.Quit result

Option Explicit
' Container Loader - console-free launcher
Dim fso, shell, baseDir, pagePath
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
pagePath = fso.BuildPath(baseDir, "index.html")
If Not fso.FileExists(pagePath) Then
  MsgBox "index.html not found:" & vbCrLf & pagePath, vbExclamation, "Container Loader"
  WScript.Quit 1
End If
shell.Run """" & pagePath & """", 1, False

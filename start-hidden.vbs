' Starts the WhatsApp bridge with no console window.
' Put a shortcut to this in shell:startup to have it run at login.
Dim sh, here
Set sh = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
sh.Run "node bridge.js", 0, False

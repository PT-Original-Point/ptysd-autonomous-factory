Option Explicit

' Separate hidden launcher for the on-demand Codex Executor task.
' HiddenWorker.vbs and the existing PTYSD-Native-OpenCode action are untouched.
Dim shell, commandLine, exitCode, argumentCount
argumentCount = WScript.Arguments.Count
If argumentCount <> 3 And argumentCount <> 4 Then WScript.Quit 64

commandLine = QuoteArg(WScript.Arguments(0)) & " " & _
              QuoteArg(WScript.Arguments(1)) & " --config " & _
              QuoteArg(WScript.Arguments(2))
If argumentCount = 4 Then
    commandLine = commandLine & " --manifest-dir " & QuoteArg(WScript.Arguments(3))
End If
Set shell = CreateObject("WScript.Shell")
exitCode = shell.Run(commandLine, 0, True)
WScript.Quit exitCode

Function QuoteArg(value)
    QuoteArg = """" & Replace(value, """", """""") & """"
End Function

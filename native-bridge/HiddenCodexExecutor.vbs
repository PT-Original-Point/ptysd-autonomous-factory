Option Explicit

' Separate hidden launcher for the on-demand Codex Executor task.
' HiddenWorker.vbs and the existing PTYSD-Native-OpenCode action are untouched.
Dim shell, commandLine, exitCode
If WScript.Arguments.Count <> 3 Then WScript.Quit 64

commandLine = QuoteArg(WScript.Arguments(0)) & " " & _
              QuoteArg(WScript.Arguments(1)) & " --config " & _
              QuoteArg(WScript.Arguments(2))
Set shell = CreateObject("WScript.Shell")
exitCode = shell.Run(commandLine, 0, True)
WScript.Quit exitCode

Function QuoteArg(value)
    QuoteArg = """" & Replace(value, """", """""") & """"
End Function

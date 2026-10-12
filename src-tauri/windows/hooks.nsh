!define OLD_PRODUCT_NAME "Claude Usage Tracker"
!define OLD_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${OLD_PRODUCT_NAME}"

Var OldUninstallString
Var OldInstallLocation
Var OldUninstallExitCode
Var OldFirstChar

!macro NSIS_HOOK_PREINSTALL
!if "${PRODUCTNAME}" == "CU"
  ClearErrors
  ReadRegStr $OldUninstallString HKCU "${OLD_UNINSTALL_KEY}" "UninstallString"
  ${If} $OldUninstallString != ""
    ReadRegStr $OldInstallLocation HKCU "${OLD_UNINSTALL_KEY}" "InstallLocation"
    StrCpy $OldFirstChar $OldInstallLocation 1
    ${If} $OldFirstChar == '"'
      StrCpy $OldInstallLocation $OldInstallLocation -1 1
    ${EndIf}

    ${If} $OldInstallLocation != ""
      ClearErrors
      ExecWait '$OldUninstallString /S _?=$OldInstallLocation' $OldUninstallExitCode
      ${IfThen} ${Errors} ${|} StrCpy $OldUninstallExitCode 2 ${|}
    ${Else}
      StrCpy $OldUninstallExitCode 2
    ${EndIf}

    ClearErrors
    ReadRegStr $OldUninstallString HKCU "${OLD_UNINSTALL_KEY}" "UninstallString"
    ${If} $OldUninstallExitCode <> 0
    ${OrIf} $OldUninstallString != ""
      MessageBox MB_OK|MB_ICONSTOP "Не удалось удалить ${OLD_PRODUCT_NAME}. Установка CU остановлена, чтобы приложения не остались рядом." /SD IDOK
      Abort
    ${EndIf}

    Delete "$OldInstallLocation\uninstall.exe"
    RMDir "$OldInstallLocation"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${OLD_PRODUCT_NAME}"
  ${EndIf}
!endif
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${OLD_PRODUCT_NAME}"
!macroend

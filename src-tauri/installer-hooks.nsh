; Extra registration Tauri's NSIS template does not do.
;
; Windows will not let an installer silently become the default handler for an
; extension — only a UserChoice written by the user through the shell can do
; that. What an installer *can* do is register the app properly so it shows up
; as a first-class option in "Open with" and in Settings > Default apps.
; Without the Capabilities/RegisteredApplications keys below, the app is
; missing from that Settings list entirely and the user has no obvious way to
; pick it.

!macro NSIS_HOOK_POSTINSTALL

  ; --- desktop shortcut ---
  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"

  ; --- application registration: puts us in the "Open with" list ---
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" \
    "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" \
    "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".md" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".markdown" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".mdown" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".mkd" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".mdx" ""

  ; --- capabilities: puts us in Settings > Apps > Default apps ---
  WriteRegStr SHCTX "Software\${PRODUCTNAME}\Capabilities" \
    "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\${PRODUCTNAME}\Capabilities" \
    "ApplicationDescription" "Renders markdown files. No editor, no vault, no plugins."
  WriteRegStr SHCTX "Software\${PRODUCTNAME}\Capabilities\FileAssociations" ".md" "Markdown Document"
  WriteRegStr SHCTX "Software\${PRODUCTNAME}\Capabilities\FileAssociations" ".markdown" "Markdown Document"
  WriteRegStr SHCTX "Software\${PRODUCTNAME}\Capabilities\FileAssociations" ".mdown" "Markdown Document"
  WriteRegStr SHCTX "Software\${PRODUCTNAME}\Capabilities\FileAssociations" ".mkd" "Markdown Document"
  WriteRegStr SHCTX "Software\${PRODUCTNAME}\Capabilities\FileAssociations" ".mdx" "Markdown Document"
  WriteRegStr SHCTX "Software\RegisteredApplications" \
    "${PRODUCTNAME}" "Software\${PRODUCTNAME}\Capabilities"

  ; let the shell notice the new registration without a sign-out
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'

!macroend

!macro NSIS_HOOK_PREUNINSTALL

  Delete "$DESKTOP\${PRODUCTNAME}.lnk"

  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  DeleteRegKey SHCTX "Software\${PRODUCTNAME}\Capabilities"
  DeleteRegKey /ifempty SHCTX "Software\${PRODUCTNAME}"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'

!macroend

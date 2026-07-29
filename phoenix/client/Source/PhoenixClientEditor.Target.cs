// Copyright Project Phoenix.
using UnrealBuildTool;

public class PhoenixClientEditorTarget : TargetRules
{
    public PhoenixClientEditorTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Editor;
        DefaultBuildSettings = BuildSettingsVersion.V5;
        IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
        ExtraModuleNames.Add("PhoenixClient");
    }
}

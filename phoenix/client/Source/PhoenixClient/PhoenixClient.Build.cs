// Copyright Project Phoenix. Module build rules.
using UnrealBuildTool;

public class PhoenixClient : ModuleRules
{
    public PhoenixClient(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(new string[]
        {
            "Core",
            "CoreUObject",
            "Engine",
            "InputCore",
            "EnhancedInput",
        });

        // HTTP + JSON are how the client talks to the Phoenix backend services.
        PrivateDependencyModuleNames.AddRange(new string[]
        {
            "HTTP",
            "Json",
            "JsonUtilities",
        });
    }
}

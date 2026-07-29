// Copyright Project Phoenix. Default game mode.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "PhoenixGameMode.generated.h"

/** Boots the match with the Phoenix character as the default pawn. */
UCLASS()
class PHOENIXCLIENT_API APhoenixGameMode : public AGameModeBase
{
    GENERATED_BODY()

public:
    APhoenixGameMode();
};

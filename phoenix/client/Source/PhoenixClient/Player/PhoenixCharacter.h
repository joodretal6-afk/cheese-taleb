// Copyright Project Phoenix. Player character.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "PhoenixCharacter.generated.h"

class UInputAction;
class UInputMappingContext;
struct FInputActionValue;

/**
 * The on-foot player pawn. Movement/look/jump via Enhanced Input, plus an
 * Interact action (default: F) that line-traces ahead and, if it hits a vehicle
 * pawn, possesses it — the GTA-style enter-vehicle flow. Advanced traversal
 * (mantle/slide/vault) hangs off the same input layer and is added next.
 */
UCLASS()
class PHOENIXCLIENT_API APhoenixCharacter : public ACharacter
{
    GENERATED_BODY()

public:
    APhoenixCharacter();

protected:
    virtual void BeginPlay() override;
    virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) override;

    void Move(const FInputActionValue& Value);
    void Look(const FInputActionValue& Value);
    void Interact();

    UPROPERTY(EditDefaultsOnly, Category = "Phoenix|Input")
    TObjectPtr<UInputMappingContext> MappingContext;

    UPROPERTY(EditDefaultsOnly, Category = "Phoenix|Input")
    TObjectPtr<UInputAction> MoveAction;

    UPROPERTY(EditDefaultsOnly, Category = "Phoenix|Input")
    TObjectPtr<UInputAction> LookAction;

    UPROPERTY(EditDefaultsOnly, Category = "Phoenix|Input")
    TObjectPtr<UInputAction> JumpAction;

    UPROPERTY(EditDefaultsOnly, Category = "Phoenix|Input")
    TObjectPtr<UInputAction> InteractAction;

    /** How far ahead to look for a vehicle to enter, in cm. */
    UPROPERTY(EditDefaultsOnly, Category = "Phoenix|Interact")
    float InteractReach = 220.f;
};

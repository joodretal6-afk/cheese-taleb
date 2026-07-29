// Copyright Project Phoenix. Client-side bridge to the Auth microservice.
#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "Interfaces/IHttpRequest.h"
#include "PhoenixAuthSubsystem.generated.h"

/** Broadcast when a login/register attempt finishes. */
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FOnAuthCompleted, bool, bSuccess, const FString&, Message);

/**
 * Talks to the Phoenix Auth service (POST /auth/register, /auth/login) over
 * HTTP, parses the JSON result, and holds the access token for the session.
 * Every other service call attaches this token as `Authorization: Bearer`.
 *
 * BaseUrl defaults to a local dev gateway; ship builds point it at the CDN edge.
 */
UCLASS()
class PHOENIXCLIENT_API UPhoenixAuthSubsystem : public UGameInstanceSubsystem
{
    GENERATED_BODY()

public:
    UPROPERTY(BlueprintAssignable, Category = "Phoenix|Auth")
    FOnAuthCompleted OnAuthCompleted;

    UFUNCTION(BlueprintCallable, Category = "Phoenix|Auth")
    void Login(const FString& Email, const FString& Password);

    UFUNCTION(BlueprintCallable, Category = "Phoenix|Auth")
    void Register(const FString& Email, const FString& Username, const FString& Password);

    UFUNCTION(BlueprintPure, Category = "Phoenix|Auth")
    bool IsAuthenticated() const { return !AccessToken.IsEmpty(); }

    UFUNCTION(BlueprintPure, Category = "Phoenix|Auth")
    FString GetAccessToken() const { return AccessToken; }

    UFUNCTION(BlueprintPure, Category = "Phoenix|Auth")
    FString GetUserId() const { return UserId; }

    /** Override the Auth service base URL (e.g. from a config/env at boot). */
    UFUNCTION(BlueprintCallable, Category = "Phoenix|Auth")
    void SetBaseUrl(const FString& Url) { BaseUrl = Url; }

private:
    void PostJson(const FString& Path, const FString& Body);
    void HandleResponse(FHttpRequestPtr Request, FHttpResponsePtr Response, bool bWasSuccessful);

    UPROPERTY()
    FString BaseUrl = TEXT("http://127.0.0.1:4001");

    UPROPERTY()
    FString AccessToken;

    UPROPERTY()
    FString UserId;
};

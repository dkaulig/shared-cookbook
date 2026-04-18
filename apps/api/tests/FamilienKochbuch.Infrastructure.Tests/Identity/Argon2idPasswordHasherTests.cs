using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Identity;
using Microsoft.AspNetCore.Identity;
using Xunit;

namespace FamilienKochbuch.Infrastructure.Tests.Identity;

/// <summary>
/// Exercises the Argon2id hasher used behind ASP.NET Identity's IPasswordHasher.
/// Tests hit the real Argon2 implementation so a regression in parameters
/// (memory/time cost) or in salt generation is caught.
/// </summary>
public class Argon2idPasswordHasherTests
{
    private readonly Argon2idPasswordHasher _hasher = new();
    private readonly User _user = new();

    [Fact]
    public void HashPassword_Produces_Argon2id_Prefixed_Hash()
    {
        var hash = _hasher.HashPassword(_user, "s3cr3t-password");

        Assert.StartsWith("$argon2id$", hash);
    }

    [Fact]
    public void HashPassword_Uses_Random_Salt()
    {
        var hashA = _hasher.HashPassword(_user, "same-password");
        var hashB = _hasher.HashPassword(_user, "same-password");

        Assert.NotEqual(hashA, hashB);
    }

    [Fact]
    public void VerifyHashedPassword_Succeeds_On_Correct_Password()
    {
        var hash = _hasher.HashPassword(_user, "correct horse battery staple");

        var result = _hasher.VerifyHashedPassword(_user, hash, "correct horse battery staple");

        Assert.Equal(PasswordVerificationResult.Success, result);
    }

    [Fact]
    public void VerifyHashedPassword_Fails_On_Wrong_Password()
    {
        var hash = _hasher.HashPassword(_user, "correct horse battery staple");

        var result = _hasher.VerifyHashedPassword(_user, hash, "incorrect password");

        Assert.Equal(PasswordVerificationResult.Failed, result);
    }

    [Fact]
    public void VerifyHashedPassword_Fails_On_Tampered_Hash()
    {
        var hash = _hasher.HashPassword(_user, "correct horse battery staple");
        // Flip one character in the encoded hash to simulate tampering.
        var tampered = hash.Substring(0, hash.Length - 1) + (hash[^1] == 'A' ? 'B' : 'A');

        var result = _hasher.VerifyHashedPassword(_user, tampered, "correct horse battery staple");

        Assert.Equal(PasswordVerificationResult.Failed, result);
    }

    [Fact]
    public void VerifyHashedPassword_Fails_Gracefully_On_Garbage()
    {
        var result = _hasher.VerifyHashedPassword(_user, "not-a-real-hash", "anything");

        Assert.Equal(PasswordVerificationResult.Failed, result);
    }
}

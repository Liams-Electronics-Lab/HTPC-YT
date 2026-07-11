{
  description = "HTPC-YT flake";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs =
    {
      nixpkgs,
      ...
    }:
    let
      forAllSystems = with nixpkgs; (lib.genAttrs lib.systems.flakeExposed);
      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.stdenv.mkDerivation {
            pname = "htpc-yt";
            version = "1.0.0";
            src = ./SRC;
            nativeBuildInputs = [ pkgs.makeWrapper ];
            buildPhase = ":";
            installPhase = ''
              runHook preInstall
              mkdir -p $out/lib/htpc-yt $out/bin
              cp -r . $out/lib/htpc-yt/
              rm -rf $out/lib/htpc-yt/node_modules
              substituteInPlace $out/lib/htpc-yt/index.js \
                --replace-fail "path.join(__dirname, 'UserData')" \
                  "path.join(require('os').homedir(), '.local', 'share', 'htpc-yt', 'UserData')" \
                --replace-fail "path.join(__dirname, 'settings.ini')" \
                  "path.join(require('os').homedir(), '.local', 'share', 'htpc-yt', 'settings.ini')"
              makeWrapper ${pkgs.electron}/bin/electron $out/bin/htpc-yt \
                --add-flags "$out/lib/htpc-yt"
              runHook postInstall
            '';
          };
        }
      );
      inherit formatter;
    };
}

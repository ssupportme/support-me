.PHONY: build test clean

build:
	cd ../.. && cargo build --manifest-path contracts/donation/Cargo.toml --target wasm32-unknown-unknown --release

test:
	cd ../.. && cargo test --manifest-path contracts/donation/Cargo.toml --lib

clean:
	cd ../.. && cargo clean --manifest-path contracts/donation/Cargo.toml

fmt:
	cd ../.. && cargo fmt --manifest-path contracts/donation/Cargo.toml

lint:
	cd ../.. && cargo clippy --manifest-path contracts/donation/Cargo.toml --target wasm32-unknown-unknown

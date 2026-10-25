package main

import (
	"millstrand/internal/app"
	"os"
)

func main() { os.Exit(app.Strand(os.Args[1:])) }

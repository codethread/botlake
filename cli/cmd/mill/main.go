package main

import (
	"millstrand/internal/app"
	"os"
)

func main() { os.Exit(app.Mill(os.Args[1:])) }

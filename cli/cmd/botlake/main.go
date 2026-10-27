package main

import (
	"botlake/internal/app"
	"os"
)

func main() { os.Exit(app.Botlake(os.Args[1:])) }
